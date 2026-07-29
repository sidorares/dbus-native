// Connecting, naming, introspecting and walking real services.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const {
  system,
  session,
  DBUS,
  listNames,
  introspect,
  walk,
  close
} = require('./helpers');

describe('bus basics', { timeout: 30000 }, () => {
  let sys, ses;

  before(async () => {
    sys = system();
    ses = session();
    await Promise.all([sys.getId(), ses.getId()]);
  });
  after(() => close(sys, ses));

  it('connects to the system bus and gets a unique name', async () => {
    const name = await sys.invoke({ ...DBUS, member: 'GetId' });
    assert.match(name, /^[0-9a-f]{32}$/, 'the bus GUID');
    assert.match(sys.name, /^:\d+\.\d+$/, `unique name, got ${sys.name}`);
  });

  it('connects to the session bus, which is a different bus', async () => {
    const [a, b] = await Promise.all([
      sys.invoke({ ...DBUS, member: 'GetId' }),
      ses.invoke({ ...DBUS, member: 'GetId' })
    ]);
    assert.notStrictEqual(a, b);
  });

  it('sees the desktop services on the system bus', async () => {
    const names = await listNames(sys);
    // UPower and Accounts start in a container; the rest depend on hardware.
    for (const expected of ['org.freedesktop.UPower', 'org.freedesktop.DBus']) {
      assert.ok(names.includes(expected), `${expected} is on the bus`);
    }
    assert.ok(
      names.filter(n => n.startsWith(':')).length >= 2,
      'and several unique names'
    );
  });

  it('answers NameHasOwner and GetNameOwner consistently', async () => {
    const owner = await sys.invoke({
      ...DBUS,
      member: 'GetNameOwner',
      signature: 's',
      body: ['org.freedesktop.UPower']
    });
    assert.match(owner, /^:\d+\.\d+$/);

    const has = await sys.invoke({
      ...DBUS,
      member: 'NameHasOwner',
      signature: 's',
      body: ['org.freedesktop.UPower']
    });
    assert.strictEqual(has, true);

    const missing = await sys.invoke({
      ...DBUS,
      member: 'NameHasOwner',
      signature: 's',
      body: ['com.example.NotThere']
    });
    assert.strictEqual(missing, false);
  });

  it('lists activatable names, which is a superset of what is running', async () => {
    const [running, activatable] = await Promise.all([
      listNames(sys),
      sys.invoke({ ...DBUS, member: 'ListActivatableNames' })
    ]);
    assert.ok(activatable.length > 0, 'the container ships service files');
    const wellKnownRunning = running.filter(n => !n.startsWith(':'));
    assert.ok(
      activatable.some(n => !wellKnownRunning.includes(n)),
      'and at least one is not started yet'
    );
  });

  it('reads a real service unique-name owner back to a pid', async () => {
    const pid = await sys.invoke({
      ...DBUS,
      member: 'GetConnectionUnixProcessID',
      signature: 's',
      body: ['org.freedesktop.UPower']
    });
    assert.ok(Number.isInteger(pid) && pid > 0, `a pid, got ${pid}`);
  });
});

describe('introspecting real services', { timeout: 60000 }, () => {
  let sys, ses;
  before(async () => {
    sys = system();
    ses = session();
    await Promise.all([sys.getId(), ses.getId()]);
  });
  after(() => close(sys, ses));

  it('parses UPower, which nests devices under a container path', async () => {
    const xml = await introspect(
      sys,
      'org.freedesktop.UPower',
      '/org/freedesktop/UPower'
    );
    assert.match(xml, /<node/);
    assert.match(xml, /org\.freedesktop\.UPower/);
  });

  it('walks the whole UPower tree by introspection alone', async () => {
    const tree = await walk(
      sys,
      'org.freedesktop.UPower',
      '/org/freedesktop/UPower'
    );
    assert.ok(tree.length >= 1, 'at least the root');
    // /org/freedesktop/UPower/devices is the classic container: it implements
    // nothing and exists only to hold the devices.
    const containers = tree.filter(n => n.interfaces.length === 0);
    const withIfaces = tree.filter(n => n.interfaces.length > 0);
    assert.ok(
      withIfaces.length >= 1,
      'and something that implements something'
    );
    console.log(
      `    UPower: ${tree.length} objects, ${containers.length} containers`
    );
    for (const node of tree) {
      console.log(
        `      ${node.path}  [${node.interfaces.filter(i => !i.startsWith('org.freedesktop.DBus')).join(', ')}]`
      );
    }
  });

  it('walks a deep tree without losing a branch', async () => {
    // NetworkManager and systemd both nest several levels; whichever is here.
    for (const [name, root] of [
      ['org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager'],
      ['org.freedesktop.UDisks2', '/org/freedesktop/UDisks2'],
      ['org.freedesktop.Accounts', '/org/freedesktop/Accounts']
    ]) {
      const names = await listNames(sys);
      if (!names.includes(name)) {
        console.log(`    ${name}: not on the bus, skipped`);
        continue;
      }
      const tree = await walk(sys, name, root, 60);
      const depth = Math.max(...tree.map(n => n.path.split('/').length));
      console.log(`    ${name}: ${tree.length} objects, depth ${depth}`);
      assert.ok(tree.length >= 1);
      // Every child a parent advertised must itself be reachable.
      const paths = new Set(tree.map(n => n.path));
      for (const node of tree) {
        for (const child of node.children) {
          const childPath =
            node.path === '/' ? `/${child}` : `${node.path}/${child}`;
          assert.ok(
            paths.has(childPath),
            `${childPath} was advertised but not reachable`
          );
        }
      }
    }
  });

  it('builds a proxy for a real object through getInterface', async () => {
    const iface = await new Promise((resolve, reject) =>
      sys.getInterface(
        'org.freedesktop.UPower',
        '/org/freedesktop/UPower',
        'org.freedesktop.UPower',
        (err, value) => (err ? reject(err) : resolve(value))
      )
    );
    assert.strictEqual(typeof iface.EnumerateDevices, 'function');
    const devices = await new Promise((resolve, reject) =>
      iface.EnumerateDevices((err, value) =>
        err ? reject(err) : resolve(value)
      )
    );
    assert.ok(Array.isArray(devices), 'ao comes back as an array');
    console.log(`    EnumerateDevices -> ${JSON.stringify(devices)}`);
  });

  it('reports a container path as itself, and names its children', async () => {
    // The regression that #350 fixed, against a service we did not write.
    const object = await new Promise((resolve, reject) =>
      sys.getObject(
        'org.freedesktop.UPower',
        '/org/freedesktop/UPower/devices',
        (err, value) => (err ? reject(err) : resolve(value))
      )
    );
    assert.strictEqual(object.name, '/org/freedesktop/UPower/devices');
    assert.ok(Array.isArray(object.nodes), 'the children are listed');
    console.log(
      `    devices container -> nodes ${JSON.stringify(object.nodes)}`
    );
  });
});
