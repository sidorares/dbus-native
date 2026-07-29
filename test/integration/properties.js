// Properties end to end: access control, introspection XML, and the
// PropertiesChanged signal actually arriving at a subscriber.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const { variantValue, toPlain } = require('../../lib/values');
const { sessionBus } = require('../utils/shape');

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
    Secret: { type: 's', access: 'write' },
    // Property names are not member names -- '-' is the GObject convention and
    // every other implementation reads one happily. 0.11.0 refused to export
    // this at all.
    'my-prop': 's'
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
    serviceBus = sessionBus();
    clientBus = sessionBus();
    impl = Object.assign(Object.create(EventEmitter.prototype), {
      Greeting: 'hello',
      Locked: true,
      Secret: 'shh',
      'my-prop': 'hyphen works'
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
          // `a{sv}` of pairs-of-variants classically, a plain object under
          // `plainValues`. toPlain() flattens both to the same thing.
          changed: toPlain(body[1]),
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

  // A property name is a string *argument* to Get/Set, never a header field,
  // so the daemon never parses it and neither should we. Exercised end to end
  // because that is the only way to show the whole path works: the export, the
  // XML, the lookup by name, and the change signal.
  describe("a property name containing '-'", () => {
    it('appears in the introspection XML', async () => {
      const xml = await clientBus.invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: 'org.freedesktop.DBus.Introspectable',
        member: 'Introspect'
      });
      assert.match(
        xml,
        /<property name="my-prop" type="s" access="readwrite"\/>/
      );
    });

    it('reads and writes', async () => {
      const before = await call('Get', 'ss', [IFACE, 'my-prop']);
      assert.strictEqual(variantValue(before), 'hyphen works');
      await call('Set', 'ssv', [IFACE, 'my-prop', ['s', 'and writes']]);
      assert.strictEqual(impl['my-prop'], 'and writes');
      const after = await call('Get', 'ss', [IFACE, 'my-prop']);
      assert.strictEqual(variantValue(after), 'and writes');
    });

    it('is carried by PropertiesChanged', async () => {
      const change = nextChange();
      await call('Set', 'ssv', [IFACE, 'my-prop', ['s', 'signalled']]);
      assert.deepStrictEqual(await change, {
        interfaceName: IFACE,
        changed: { 'my-prop': 'signalled' },
        invalidated: []
      });
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
      assert.deepStrictEqual(Object.keys(toPlain(all)), [
        'Greeting',
        'Locked',
        'my-prop'
      ]);
    });

    it('still reads and writes a readwrite property', async () => {
      await call('Set', 'ssv', [IFACE, 'Greeting', ['s', 'written']]);
      assert.strictEqual(impl.Greeting, 'written');
      const value = await call('Get', 'ss', [IFACE, 'Greeting']);
      assert.strictEqual(variantValue(value), 'written');
    });

    it('still reads a read-only property', async () => {
      const value = await call('Get', 'ss', [IFACE, 'Locked']);
      assert.strictEqual(variantValue(value), true);
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
