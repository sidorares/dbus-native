// Properties end to end: access control, introspection XML, and the
// PropertiesChanged signal actually arriving at a subscriber.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const dbus = require('../../index');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Props';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/Props';
const IFACE = 'com.github.sidorares.dbusnative.PropsIface';
const PROPS = 'org.freedesktop.DBus.Properties';

const ifaceDesc = {
  name: IFACE,
  methods: {},
  signals: {},
  properties: {
    // the classic form: a bare signature, still meaning readwrite
    Greeting: 's',
    Locked: { type: 'b', access: 'read' },
    Secret: { type: 's', access: 'write' }
  }
};

describe('integration: properties', { timeout: 10000, skip: NO_BUS }, () => {
  let serviceBus, clientBus, impl;

  const whenReady = bus =>
    new Promise((resolve, reject) =>
      bus.getId(err => (err ? reject(err) : resolve()))
    );

  const call = (member, signature, body) =>
    clientBus.invoke({
      destination: SERVICE,
      path: OBJECT_PATH,
      interface: PROPS,
      member,
      signature,
      body
    });

  before(async () => {
    serviceBus = dbus.sessionBus();
    clientBus = dbus.sessionBus();
    impl = Object.assign(Object.create(EventEmitter.prototype), {
      Greeting: 'hello',
      Locked: true,
      Secret: 'shh'
    });
    EventEmitter.call(impl);

    await Promise.all([whenReady(serviceBus), whenReady(clientBus)]);
    await new Promise((resolve, reject) =>
      serviceBus.requestName(SERVICE, 0, err => {
        if (err) return reject(err);
        serviceBus.exportInterface(impl, OBJECT_PATH, ifaceDesc);
        resolve();
      })
    );
    await clientBus.addMatch(
      `type='signal',path='${OBJECT_PATH}',interface='${PROPS}'`
    );
  });

  after(() => {
    for (const bus of [serviceBus, clientBus]) if (bus) bus.connection.end();
  });

  // Resolves with the next PropertiesChanged, flattened to plain values.
  const nextChange = () =>
    new Promise(resolve => {
      const key = clientBus.mangle(OBJECT_PATH, PROPS, 'PropertiesChanged');
      clientBus.signals.once(key, body =>
        resolve({
          interfaceName: body[0],
          changed: Object.fromEntries(body[1].map(([k, v]) => [k, v[1][0]])),
          invalidated: body[2]
        })
      );
    });

  describe('introspection', () => {
    it('advertises the declared access, not readwrite for everything', async () => {
      const xml = await clientBus.invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: 'org.freedesktop.DBus.Introspectable',
        member: 'Introspect'
      });
      assert.match(
        xml,
        /<property name="Greeting" type="s" access="readwrite"\/>/
      );
      assert.match(xml, /<property name="Locked" type="b" access="read"\/>/);
      assert.match(xml, /<property name="Secret" type="s" access="write"\/>/);
    });
  });

  describe('access control', () => {
    it('rejects writing a read-only property', async () => {
      await assert.rejects(
        () => call('Set', 'ssv', [IFACE, 'Locked', ['b', false]]),
        err => {
          assert.strictEqual(
            err.dbusName,
            'org.freedesktop.DBus.Error.PropertyReadOnly'
          );
          return true;
        }
      );
      assert.strictEqual(impl.Locked, true, 'value must be unchanged');
    });

    it('rejects reading a write-only property', async () => {
      await assert.rejects(() => call('Get', 'ss', [IFACE, 'Secret']), {
        dbusName: 'org.freedesktop.DBus.Error.AccessDenied'
      });
    });

    it('omits write-only properties from GetAll', async () => {
      const all = await call('GetAll', 's', [IFACE]);
      const names = all.map(([k]) => k);
      assert.deepStrictEqual(names, ['Greeting', 'Locked']);
    });

    it('still reads and writes a readwrite property', async () => {
      await call('Set', 'ssv', [IFACE, 'Greeting', ['s', 'written']]);
      assert.strictEqual(impl.Greeting, 'written');
      const value = await call('Get', 'ss', [IFACE, 'Greeting']);
      assert.strictEqual(value[1][0], 'written');
    });

    it('still reads a read-only property', async () => {
      const value = await call('Get', 'ss', [IFACE, 'Locked']);
      assert.strictEqual(value[1][0], true);
    });

    it('still rejects an undeclared property', async () => {
      await assert.rejects(() => call('Get', 'ss', [IFACE, 'Nope']), {
        dbusName: 'org.freedesktop.DBus.Error.UnknownProperty'
      });
    });
  });

  describe('PropertiesChanged', () => {
    it('is emitted when Set writes a property', async () => {
      const change = nextChange();
      await call('Set', 'ssv', [IFACE, 'Greeting', ['s', 'via set']]);
      assert.deepStrictEqual(await change, {
        interfaceName: IFACE,
        changed: { Greeting: 'via set' },
        invalidated: []
      });
    });

    it('invalidates rather than broadcasts a write-only property', async () => {
      // There is no value to send, so subscribers are told to re-read.
      const change = nextChange();
      await call('Set', 'ssv', [IFACE, 'Secret', ['s', 'new secret']]);
      const got = await change;
      assert.deepStrictEqual(got.changed, {});
      assert.deepStrictEqual(got.invalidated, ['Secret']);
      assert.strictEqual(impl.Secret, 'new secret');
    });

    it('can be emitted by the service itself', async () => {
      // Assigning to impl.Greeting is an ordinary property write and cannot be
      // observed, so a service announces its own changes explicitly.
      const change = nextChange();
      impl.Greeting = 'changed locally';
      serviceBus.emitPropertiesChanged(OBJECT_PATH, IFACE, {
        Greeting: impl.Greeting
      });
      assert.deepStrictEqual(await change, {
        interfaceName: IFACE,
        changed: { Greeting: 'changed locally' },
        invalidated: []
      });
    });

    it('carries invalidated names given by the service', async () => {
      const change = nextChange();
      serviceBus.emitPropertiesChanged(OBJECT_PATH, IFACE, {}, ['Locked']);
      const got = await change;
      assert.deepStrictEqual(got.invalidated, ['Locked']);
    });

    it('refuses to announce a property the interface does not declare', () => {
      assert.throws(
        () => serviceBus.emitPropertiesChanged(OBJECT_PATH, IFACE, { Nope: 1 }),
        /No such property "Nope"/
      );
    });

    it('refuses to announce on an interface that is not exported', () => {
      assert.throws(
        () => serviceBus.emitPropertiesChanged(OBJECT_PATH, 'not.here', {}),
        /No interface "not.here" exported/
      );
    });
  });
});
