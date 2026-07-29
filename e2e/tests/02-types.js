// The type system, against signatures real services actually use.
//
// The interesting part is that we do not get to choose the shapes here. A
// service written by somebody else decides what comes down the wire, so this
// is the closest thing to a fuzz corpus the ecosystem provides.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const {
  dbus,
  system,
  session,
  listNames,
  introspect,
  getProperty,
  getAll,
  walk,
  close
} = require('./helpers');

const { parseStringPromise } = require('/work/node_modules/xml2js');

describe('signature coverage', { timeout: 120000 }, () => {
  let sys, ses;
  before(async () => {
    sys = system();
    ses = session();
    await Promise.all([sys.getId(), ses.getId()]);
  });
  after(() => close(sys, ses));

  it('catalogues every signature the container advertises', async () => {
    const signatures = new Map(); // signature -> where it was first seen
    const parse = require('/work/lib/signature');
    // systemd exports one object per unit and one per job, so an unbounded
    // recursion is thousands of round trips for no extra type coverage: the
    // units all implement the same two interfaces.
    const MAX_OBJECTS = Number(process.env.E2E_MAX_OBJECTS || 250);
    let visited = 0;

    const collect = async (bus, name, path) => {
      if (visited++ > MAX_OBJECTS) return;
      let doc;
      try {
        doc = await parseStringPromise(await introspect(bus, name, path));
      } catch {
        return;
      }
      for (const iface of (doc.node || {}).interface || []) {
        const note = (sig, where) => {
          if (!sig) return;
          if (!signatures.has(sig)) signatures.set(sig, where);
        };
        for (const method of iface.method || []) {
          for (const arg of method.arg || []) {
            note(arg.$.type, `${iface.$.name}.${method.$.name}`);
          }
        }
        for (const signal of iface.signal || []) {
          for (const arg of signal.arg || []) {
            note(arg.$.type, `${iface.$.name}.${signal.$.name}`);
          }
        }
        for (const prop of iface.property || []) {
          note(prop.$.type, `${iface.$.name}.${prop.$.name}`);
        }
      }
      for (const child of (doc.node || {}).node || []) {
        if (child.$ && child.$.name) {
          await collect(
            bus,
            name,
            path === '/' ? `/${child.$.name}` : `${path}/${child.$.name}`
          );
        }
      }
    };

    for (const [bus, label] of [
      [sys, 'system'],
      [ses, 'session']
    ]) {
      visited = 0;
      for (const name of await listNames(bus)) {
        if (name.startsWith(':')) continue;
        visited = 0;
        const root = `/${name.replace(/\./g, '/')}`;
        await collect(bus, name, root);
        visited = 0;
        await collect(bus, name, '/');
      }
      console.log(`    after ${label}: ${signatures.size} distinct signatures`);
    }

    // Every one of them must parse. This is the real assertion: the parser
    // meets whatever the desktop emits, not just what our tests invent.
    const failures = [];
    for (const [sig, where] of signatures) {
      try {
        parse(sig);
      } catch (err) {
        failures.push(`${sig} (${where}): ${err.message}`);
      }
    }
    assert.deepStrictEqual(failures, [], 'every advertised signature parses');

    const byLength = [...signatures.keys()].sort((a, b) => b.length - a.length);
    console.log(`    ${signatures.size} distinct signatures. All of them:`);
    for (const sig of byLength) {
      console.log(`      ${sig.padEnd(22)} <- ${signatures.get(sig)}`);
    }

    // Which type codes turned up at all. The interesting entry is 'h', the
    // one this library cannot carry -- see ROADMAP 2.8.
    const codes = [...new Set([...signatures.keys()].flatMap(s => [...s]))]
      .filter(c => /[a-z]/i.test(c))
      .sort();
    console.log(`    type codes seen: ${codes.join(' ')}`);

    assert.ok(signatures.size > 30, `only ${signatures.size} signatures seen`);
  });

  it('reads a{sv} from a real service', async () => {
    const all = await getAll(
      sys,
      'org.freedesktop.UPower',
      '/org/freedesktop/UPower',
      'org.freedesktop.UPower'
    );
    // The classic shape: an array of [key, [signatureTree, [value]]] pairs.
    assert.ok(Array.isArray(all));
    assert.ok(all.length > 0, 'UPower has properties');
    for (const entry of all) {
      assert.strictEqual(entry.length, 2, 'a dict entry is a pair');
    }
    const asObject = dbus.toPlain(all);
    assert.strictEqual(typeof asObject, 'object');
    console.log(`    UPower.GetAll -> ${JSON.stringify(asObject)}`);
  });

  it('reads the same a{sv} as a plain object under plainValues', async () => {
    const plain = session({ plainValues: true });
    const sysPlain = system({ plainValues: true });
    await Promise.all([plain.getId(), sysPlain.getId()]);
    try {
      const all = await getAll(
        sysPlain,
        'org.freedesktop.UPower',
        '/org/freedesktop/UPower',
        'org.freedesktop.UPower'
      );
      assert.ok(!Array.isArray(all), 'a string-keyed dict becomes an object');
      assert.ok('DaemonVersion' in all, `got keys ${Object.keys(all)}`);
      assert.strictEqual(typeof all.DaemonVersion, 'string', 'unwrapped');
      console.log(`    plainValues -> ${JSON.stringify(all)}`);
    } finally {
      close(plain, sysPlain);
    }
  });

  it('unwraps a variant with variantValue in either shape', async () => {
    const classic = await getProperty(
      sys,
      'org.freedesktop.UPower',
      '/org/freedesktop/UPower',
      'org.freedesktop.UPower',
      'DaemonVersion'
    );
    assert.strictEqual(typeof dbus.variantValue(classic), 'string');
    assert.strictEqual(dbus.variantSignature(classic), 's');

    const plainBus = system({ plainValues: true });
    await plainBus.getId();
    try {
      const plain = await getProperty(
        plainBus,
        'org.freedesktop.UPower',
        '/org/freedesktop/UPower',
        'org.freedesktop.UPower',
        'DaemonVersion'
      );
      assert.strictEqual(typeof plain, 'string', 'already a plain value');
      assert.strictEqual(dbus.variantValue(plain), plain, 'and idempotent');
    } finally {
      close(plainBus);
    }
  });

  it('reads a 64-bit property as a number and as a bigint', async () => {
    // Search for a readable t or x rather than guessing at a service: which
    // ones start in a container is not something to hardcode.
    const target = await (async () => {
      for (const name of await listNames(sys)) {
        if (name.startsWith(':')) continue;
        // The 64-bit properties live on device objects, not on the root --
        // NetworkManager keeps TxBytes per interface, UPower TimeToEmpty per
        // battery -- so this has to descend.
        const tree = await walk(sys, name, `/${name.replace(/\./g, '/')}`, 40);
        for (const node of tree) {
          let doc;
          try {
            doc = await parseStringPromise(
              await introspect(sys, name, node.path)
            );
          } catch {
            continue;
          }
          for (const iface of (doc.node || {}).interface || []) {
            for (const prop of iface.property || []) {
              const { type, access, name: propName } = prop.$;
              if ((type !== 't' && type !== 'x') || access === 'write')
                continue;
              try {
                await getProperty(sys, name, node.path, iface.$.name, propName);
                return [name, node.path, iface.$.name, propName];
              } catch {
                /* not readable here; keep looking */
              }
            }
          }
        }
      }
      return null;
    })();
    if (!target)
      return console.log('    no 64-bit property available, skipped');

    const [name, path, iface, prop] = target;
    console.log(`    using ${iface}.${prop} on ${name}`);
    const asNumber = dbus.variantValue(
      await getProperty(sys, name, path, iface, prop)
    );
    assert.strictEqual(typeof asNumber, 'number');

    const big = system({ returnBigInt: true });
    await big.getId();
    try {
      const asBigInt = dbus.variantValue(
        await getProperty(big, name, path, iface, prop)
      );
      assert.strictEqual(typeof asBigInt, 'bigint');
      assert.strictEqual(Number(asBigInt), asNumber, 'the same value');
      console.log(`    ${prop}: ${asNumber} / ${asBigInt}n`);
    } finally {
      close(big);
    }
  });

  it('reads the deepest nesting in common use: a{oa{sa{sv}}}', async () => {
    // ObjectManager.GetManagedObjects. Dict of object path -> dict of
    // interface -> dict of property -> variant.
    const names = await listNames(sys);
    const managers = [
      ['org.freedesktop.UDisks2', '/org/freedesktop/UDisks2'],
      ['org.freedesktop.Accounts', '/org/freedesktop/Accounts'],
      ['org.freedesktop.NetworkManager', '/org/freedesktop']
    ].filter(([name]) => names.includes(name));

    let read = 0;
    for (const [name, path] of managers) {
      let managed;
      try {
        managed = await sys.invoke({
          destination: name,
          path,
          interface: 'org.freedesktop.DBus.ObjectManager',
          member: 'GetManagedObjects'
        });
      } catch (err) {
        console.log(
          `    ${name}: no ObjectManager (${err.dbusName || err.message})`
        );
        continue;
      }
      read++;
      assert.ok(Array.isArray(managed), 'the outer dict is an array of pairs');
      const plain = dbus.toPlain(managed);
      const paths = Object.keys(plain);
      console.log(`    ${name}: ${paths.length} managed objects`);
      for (const objectPath of paths.slice(0, 3)) {
        const ifaces = Object.keys(plain[objectPath]);
        console.log(`      ${objectPath} -> ${ifaces.length} interfaces`);
        assert.ok(objectPath.startsWith('/'), 'keyed by object path');
      }
    }
    assert.ok(read > 0, 'at least one ObjectManager answered');
  });

  it('explains itself when a real method wants a UNIX_FD', async () => {
    // UDisks2.Manager.LoopSetup takes an 'h'. Nothing in Node can send one --
    // a file descriptor travels as ancillary data (SCM_RIGHTS) alongside the
    // message, not in it. The message this produces is the whole feature, so
    // it is worth checking against the service that actually asks for one.
    const names = await listNames(sys);
    if (!names.includes('org.freedesktop.UDisks2')) {
      return console.log('    UDisks2 not on the bus, skipped');
    }
    const call = () =>
      sys.invoke({
        destination: 'org.freedesktop.UDisks2',
        path: '/org/freedesktop/UDisks2/Manager',
        interface: 'org.freedesktop.UDisks2.Manager',
        member: 'LoopSetup',
        signature: 'ha{sv}',
        body: [0, []]
      });

    // Note the shape: this comes out of invoke() *synchronously*, because it
    // fails while marshalling rather than on the wire. `await call()` and a
    // try/catch both see it, but `call().catch(...)` does not, and the
    // callback form gets a throw where it expects cb(err). Everything else
    // since 0.7 delivers failures as a DBusError to the callback or the
    // rejection; this is the one place that does not.
    let thrown = null;
    try {
      await call();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'the call failed');
    assert.match(thrown.message, /UNIX_FD \('h'\) is not supported/);
    assert.match(thrown.message, /SCM_RIGHTS/, 'and says why');
    assert.match(
      thrown.message,
      /ROADMAP\.md section 2\.8/,
      'and where to look'
    );

    let synchronous = false;
    try {
      call();
    } catch {
      synchronous = true;
    }
    assert.strictEqual(synchronous, true, 'thrown before returning a thenable');
    console.log(`    ${thrown.message.split('. ')[0]}.`);
    console.log('    (raised synchronously from invoke, not as a rejection)');
  });

  it('reads ay as a Buffer, and ao as object paths', async () => {
    const names = await listNames(sys);
    if (!names.includes('org.freedesktop.UPower')) return;
    const devices = await sys.invoke({
      destination: 'org.freedesktop.UPower',
      path: '/org/freedesktop/UPower',
      interface: 'org.freedesktop.UPower',
      member: 'EnumerateDevices'
    });
    assert.ok(Array.isArray(devices));
    for (const p of devices) assert.match(p, /^\//, 'an object path');

    // Machine id is the easiest ay-adjacent thing; use Peer.GetMachineId for a
    // string and hostname1's machine id property when it is there.
    const machineId = await sys.invoke({
      destination: 'org.freedesktop.UPower',
      path: '/org/freedesktop/UPower',
      interface: 'org.freedesktop.DBus.Peer',
      member: 'GetMachineId'
    });
    assert.match(machineId, /^[0-9a-f]{32}$/);
  });
});
