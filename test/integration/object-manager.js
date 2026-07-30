// org.freedesktop.DBus.ObjectManager, served over a real bus.
//
// This is how BlueZ, NetworkManager, systemd and UDisks publish their object
// trees, so "list the devices" is GetManagedObjects everywhere. Exercised end
// to end because the interesting parts are the ones that span the whole path:
// the declaration, the introspection XML, the reply body, and the two signals
// actually arriving at a subscriber.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const { toPlain } = require('../../lib/values');
const { sessionBus } = require('../utils/shape');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Manager';
const ROOT = '/com/github/sidorares/dbusnative/Manager';
const IFACE = 'com.github.sidorares.dbusnative.Device';
const OM = 'org.freedesktop.DBus.ObjectManager';

const ifaceDesc = {
  name: IFACE,
  methods: {},
  signals: {},
  properties: {
    Name: 's',
    Address: { type: 's', access: 'read' },
    Pin: { type: 's', access: 'write' }
  }
};

const device = fields => {
  const impl = Object.assign(Object.create(EventEmitter.prototype), fields);
  EventEmitter.call(impl);
  return impl;
};

describe('integration: ObjectManager', { timeout: 10000, skip: NO_BUS }, () => {
  let serviceBus, clientBus;

  const whenReady = bus =>
    new Promise((resolve, reject) =>
      bus.getId(err => (err ? reject(err) : resolve()))
    );

  const call = (member, signature, body, path = ROOT) =>
    clientBus.invoke({
      destination: SERVICE,
      path,
      interface: OM,
      member,
      ...(signature ? { signature, body } : {})
    });

  // Resolves with the next signal of this member, as plain values.
  const nextSignal = member =>
    new Promise(resolve => {
      const key = clientBus.mangle(ROOT, OM, member);
      clientBus.signals.once(key, body => resolve(body));
    });

  before(async () => {
    serviceBus = sessionBus();
    clientBus = sessionBus();

    await Promise.all([whenReady(serviceBus), whenReady(clientBus)]);
    await new Promise((resolve, reject) =>
      serviceBus.requestName(SERVICE, 0, err => {
        if (err) return reject(err);
        serviceBus.exportObjectManager(ROOT);
        serviceBus.exportInterface(
          device({ Name: 'hci0', Address: '00:11:22', Pin: '0000' }),
          `${ROOT}/dev0`,
          ifaceDesc
        );
        resolve();
      })
    );
    await clientBus.addMatch(`type='signal',path='${ROOT}',interface='${OM}'`);
  });

  after(() => {
    for (const bus of [serviceBus, clientBus]) if (bus) bus.connection.end();
  });

  describe('GetManagedObjects', () => {
    it('reports the objects below the manager', async () => {
      const objects = toPlain(await call('GetManagedObjects'));
      assert.deepStrictEqual(objects, {
        [`${ROOT}/dev0`]: {
          [IFACE]: { Name: 'hci0', Address: '00:11:22' }
        }
      });
    });

    it('omits write-only properties, as GetAll does', async () => {
      const objects = toPlain(await call('GetManagedObjects'));
      assert.ok(
        !('Pin' in objects[`${ROOT}/dev0`][IFACE]),
        'a write-only property has no value to report'
      );
    });

    it('does not include the manager object itself', async () => {
      // The manager is not below itself. A service that exported an
      // interface at ROOT would still not see it here.
      const objects = toPlain(await call('GetManagedObjects'));
      assert.ok(!(ROOT in objects));
    });

    it('is refused at a path that did not declare it', async () => {
      await assert.rejects(
        () => call('GetManagedObjects', undefined, undefined, `${ROOT}/dev0`),
        { dbusName: 'org.freedesktop.DBus.Error.UnknownInterface' }
      );
    });
  });

  describe('introspection', () => {
    const introspect = path =>
      clientBus.invoke({
        destination: SERVICE,
        path,
        interface: 'org.freedesktop.DBus.Introspectable',
        member: 'Introspect'
      });

    it('advertises the interface at the manager path', async () => {
      const xml = await introspect(ROOT);
      assert.match(
        xml,
        /<interface name="org\.freedesktop\.DBus\.ObjectManager">/
      );
      assert.match(xml, /<method name="GetManagedObjects">/);
      assert.match(xml, /<signal name="InterfacesAdded">/);
      assert.match(xml, /<signal name="InterfacesRemoved">/);
      // A manager that only groups other objects still lists its children.
      assert.match(xml, /<node name="dev0"\/>/);
    });

    it('does not advertise it anywhere else', async () => {
      const xml = await introspect(`${ROOT}/dev0`);
      assert.ok(!xml.includes('ObjectManager'));
    });
  });

  describe('InterfacesAdded', () => {
    it('is emitted when an object is exported below the manager', async () => {
      const signal = nextSignal('InterfacesAdded');
      serviceBus.exportInterface(
        device({ Name: 'hci1', Address: '33:44:55', Pin: '1111' }),
        `${ROOT}/dev1`,
        ifaceDesc
      );
      const [path, interfaces] = await signal;
      assert.strictEqual(path, `${ROOT}/dev1`);
      assert.deepStrictEqual(toPlain(interfaces), {
        [IFACE]: { Name: 'hci1', Address: '33:44:55' }
      });
    });

    it('announces only the interface that appeared', async () => {
      const second = {
        name: 'com.github.sidorares.dbusnative.Extra',
        methods: {},
        signals: {},
        properties: { Extra: 's' }
      };
      const signal = nextSignal('InterfacesAdded');
      serviceBus.exportInterface(
        device({ Extra: 'more' }),
        `${ROOT}/dev1`,
        second
      );
      const [path, interfaces] = await signal;
      assert.strictEqual(path, `${ROOT}/dev1`);
      // Not news about the interface that was already there.
      assert.deepStrictEqual(Object.keys(toPlain(interfaces)), [second.name]);
    });

    it('is not emitted for an object outside any manager', async () => {
      let seen = false;
      const key = clientBus.mangle(ROOT, OM, 'InterfacesAdded');
      const watch = () => {
        seen = true;
      };
      clientBus.signals.on(key, watch);
      serviceBus.exportInterface(
        device({ Name: 'elsewhere', Address: '', Pin: '' }),
        '/com/github/sidorares/dbusnative/Unmanaged',
        ifaceDesc
      );
      await new Promise(resolve => setTimeout(resolve, 150));
      clientBus.signals.removeListener(key, watch);
      assert.strictEqual(seen, false);
    });
  });

  describe('InterfacesRemoved', () => {
    it('is emitted when one interface is unexported', async () => {
      const signal = nextSignal('InterfacesRemoved');
      const removed = serviceBus.unexportInterface(`${ROOT}/dev1`, IFACE);
      assert.strictEqual(removed, true);
      const [path, interfaces] = await signal;
      assert.strictEqual(path, `${ROOT}/dev1`);
      assert.deepStrictEqual(interfaces, [IFACE]);
    });

    it('names every interface when the whole object goes', async () => {
      const signal = nextSignal('InterfacesRemoved');
      serviceBus.unexportInterface(`${ROOT}/dev1`);
      const [path, interfaces] = await signal;
      assert.strictEqual(path, `${ROOT}/dev1`);
      assert.deepStrictEqual(interfaces, [
        'com.github.sidorares.dbusnative.Extra'
      ]);
    });

    it('leaves the object out of GetManagedObjects afterwards', async () => {
      const objects = toPlain(await call('GetManagedObjects'));
      assert.ok(!(`${ROOT}/dev1` in objects));
      assert.ok(`${ROOT}/dev0` in objects, 'the others are untouched');
    });

    it('reports nothing removed for a path that was never exported', () => {
      assert.strictEqual(serviceBus.unexportInterface(`${ROOT}/nope`), false);
      assert.strictEqual(
        serviceBus.unexportInterface(`${ROOT}/dev0`, 'com.example.Absent'),
        false
      );
    });
  });
});
