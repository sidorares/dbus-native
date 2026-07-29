// Signals, match rules, errors and cancellation, against real peers.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { execFileSync } = require('child_process');
const {
  dbus,
  system,
  session,
  DBUS,
  listNames,
  eventually,
  close
} = require('./helpers');

describe('signals from real services', { timeout: 40000 }, () => {
  let sys, ses;
  before(async () => {
    sys = system();
    ses = session();
    await Promise.all([sys.getId(), ses.getId()]);
  });
  after(() => close(sys, ses));

  it('receives NameOwnerChanged when a name comes and goes', async () => {
    const seen = [];
    await ses.addMatch(
      "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged'"
    );
    ses.connection.on('message', msg => {
      if (msg.member === 'NameOwnerChanged') seen.push(msg.body);
    });

    // A second connection claiming a name is the cheapest way to cause one.
    const other = session();
    await other.getId();
    const NAME = 'com.example.E2ETransient';
    await new Promise((resolve, reject) =>
      other.requestName(NAME, 0, err => (err ? reject(err) : resolve()))
    );
    await eventually(
      () => seen.find(body => body[0] === NAME && body[2] !== ''),
      { label: `${NAME} acquired` }
    );
    close(other);
    const lost = await eventually(
      () => seen.find(body => body[0] === NAME && body[2] === ''),
      { label: `${NAME} released` }
    );
    assert.strictEqual(lost[0], NAME);
    assert.strictEqual(lost[2], '', 'no new owner');
    console.log(`    saw ${seen.length} NameOwnerChanged signals`);
  });

  it('filters with an arg0 match rule', async () => {
    const NAME = 'com.example.E2EArgZero';
    const matched = [];
    await ses.addMatch(
      `type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${NAME}'`
    );
    ses.connection.on('message', msg => {
      if (msg.member === 'NameOwnerChanged') matched.push(msg.body[0]);
    });

    const noise = session();
    await noise.getId();
    await new Promise((resolve, reject) =>
      noise.requestName('com.example.E2ENoise', 0, err =>
        err ? reject(err) : resolve()
      )
    );
    const wanted = session();
    await wanted.getId();
    await new Promise((resolve, reject) =>
      wanted.requestName(NAME, 0, err => (err ? reject(err) : resolve()))
    );

    await eventually(() => matched.includes(NAME), { label: 'the arg0 match' });
    close(noise, wanted);
    // The rule above is not the only one this connection has, so we cannot
    // assert nothing else arrived -- only that the one we asked for did.
    assert.ok(matched.includes(NAME));
  });

  it('receives PropertiesChanged emitted by a real service', async () => {
    // Ask systemd to reload, or poke UPower; whichever is present will emit
    // something. Fall back to reporting that nothing volunteered.
    const names = await listNames(sys);
    if (!names.includes('org.freedesktop.systemd1')) {
      return console.log('    systemd1 not on the system bus, skipped');
    }
    const changes = [];
    await sys.addMatch(
      "type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged'"
    );
    sys.connection.on('message', msg => {
      if (msg.member === 'PropertiesChanged') changes.push(msg);
    });
    try {
      execFileSync('busctl', [
        'call',
        'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager',
        'Reload'
      ]);
    } catch {
      /* reload is not always permitted in a container */
    }
    const change = await eventually(() => changes[0], {
      timeout: 8000,
      label: 'a PropertiesChanged'
    }).catch(() => null);
    if (!change) return console.log('    nothing emitted one, skipped');
    assert.strictEqual(typeof change.body[0], 'string', 'the interface name');
    console.log(`    PropertiesChanged from ${change.body[0]}`);
  });
});

describe('errors from real services', { timeout: 30000 }, () => {
  let sys;
  before(async () => {
    sys = system();
    await sys.getId();
  });
  after(() => close(sys));

  it('reports an unknown service as ServiceUnknown', async () => {
    await assert.rejects(
      () =>
        sys.invoke({
          destination: 'com.example.NotRunning',
          path: '/',
          interface: 'com.example.Iface',
          member: 'Nope'
        }),
      err => {
        assert.ok(err instanceof dbus.DBusError, 'a DBusError');
        assert.strictEqual(
          err.dbusName,
          'org.freedesktop.DBus.Error.ServiceUnknown'
        );
        assert.ok(err.message.length > 0, 'with the daemon message');
        return true;
      }
    );
  });

  it('reports an unknown method on a real service', async () => {
    await assert.rejects(
      () =>
        sys.invoke({
          destination: 'org.freedesktop.UPower',
          path: '/org/freedesktop/UPower',
          interface: 'org.freedesktop.UPower',
          member: 'NoSuchMethod'
        }),
      err => {
        assert.match(err.dbusName, /UnknownMethod|UnknownInterface/);
        return true;
      }
    );
  });

  it('reports an unknown object path', async () => {
    await assert.rejects(
      () =>
        sys.invoke({
          destination: 'org.freedesktop.UPower',
          path: '/org/freedesktop/UPower/nope/nope',
          interface: 'org.freedesktop.DBus.Properties',
          member: 'GetAll',
          signature: 's',
          body: ['org.freedesktop.UPower']
        }),
      err => {
        assert.ok(err.dbusName, `a named error, got ${err.message}`);
        return true;
      }
    );
  });

  it('reports an unknown property', async () => {
    await assert.rejects(
      () =>
        sys.invoke({
          destination: 'org.freedesktop.UPower',
          path: '/org/freedesktop/UPower',
          interface: 'org.freedesktop.DBus.Properties',
          member: 'Get',
          signature: 'ss',
          body: ['org.freedesktop.UPower', 'NoSuchProperty']
        }),
      err => {
        assert.match(err.dbusName, /UnknownProperty|InvalidArgs/);
        return true;
      }
    );
  });

  it('carries the caller stack on a rejection', async () => {
    const err = await sys
      .invoke({
        destination: 'com.example.NotRunning',
        path: '/',
        interface: 'x.y',
        member: 'z'
      })
      .catch(e => e);
    assert.match(err.stack, /d-bus call made at/);
    assert.match(err.stack, /03-signals-errors/, 'and points back here');
  });

  it('times out or errors on a peer that owns a name but serves nothing', async () => {
    // On the session bus, because the system bus only lets allow-listed names
    // be owned -- "not allowed to own the service ... due to security policies
    // in the configuration file" is the system bus working as intended.
    const quiet = session();
    const caller = session();
    await Promise.all([quiet.getId(), caller.getId()]);
    const NAME = 'com.example.E2EQuiet';
    await new Promise((resolve, reject) =>
      quiet.requestName(NAME, 0, err => (err ? reject(err) : resolve()))
    );
    try {
      await assert.rejects(
        () =>
          caller.invoke(
            {
              destination: NAME,
              path: '/nowhere',
              interface: 'com.example.Iface',
              member: 'Hang'
            },
            { timeout: 400 }
          ),
        err => {
          // This library answers an unrouted call with an error of its own, so
          // either outcome is correct -- what matters is that the caller is
          // not left waiting forever.
          assert.ok(
            err.code === 'ETIMEDOUT' || err.dbusName,
            `expected a timeout or a named error, got ${err.message}`
          );
          console.log(`    -> ${err.dbusName || err.code}`);
          return true;
        }
      );
    } finally {
      close(quiet, caller);
    }
  });

  it('cancels an in-flight call through an AbortSignal', async () => {
    const controller = new AbortController();
    const call = sys.invoke(
      { ...DBUS, member: 'ListNames' },
      { signal: controller.signal }
    );
    controller.abort();
    await assert.rejects(() => call, { code: 'ABORT_ERR' });
  });
});
