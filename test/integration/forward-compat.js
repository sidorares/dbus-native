// The forward-compatible helpers, exercised against a real dbus-daemon so the
// values really are the ones the parser produces.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const dbus = require('../../index');
const { sessionBus, PLAIN_VALUES } = require('../utils/shape');
const { Variant, variantValue, toPlain } = dbus;
const { toClassicError } = require('../../lib/compat');

// node:test skips a whole suite from its options, evaluated at load time.
const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.ForwardCompat';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/ForwardCompat';
const IFACE = 'com.github.sidorares.dbusnative.ForwardCompatIface';

const ifaceDesc = {
  name: IFACE,
  methods: { Fail: ['', '', [], []], Quiet: ['', '', [], []] },
  signals: {},
  properties: { Greeting: 's', Count: 'u' }
};

describe(
  'integration: forward-compatible helpers',
  { timeout: 10000, skip: NO_BUS },
  () => {
    let serviceBus, clientBus, impl;

    const whenReady = bus =>
      new Promise((resolve, reject) =>
        bus.getId(err => (err ? reject(err) : resolve()))
      );

    before(async () => {
      serviceBus = sessionBus();
      clientBus = sessionBus();

      impl = Object.assign(Object.create(EventEmitter.prototype), {
        Greeting: 'hello',
        Count: 7,
        Fail() {
          const err = new Error('deliberate failure');
          err.dbusName = 'com.example.Error.Boom';
          throw err;
        },
        Quiet() {
          // throws with no message, to exercise the empty-body error path
          throw Object.assign(new Error(''), {
            dbusName: 'com.example.Error.Silent'
          });
        }
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
    });

    after(() => {
      if (serviceBus) serviceBus.connection.end();
      if (clientBus) clientBus.connection.end();
    });

    const invoke = msg =>
      new Promise(resolve =>
        clientBus.invoke(msg, (err, result) => resolve({ err, result }))
      );

    it('variantValue reads a property without index gymnastics', async () => {
      const { err, result } = await invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: 'org.freedesktop.DBus.Properties',
        member: 'Get',
        signature: 'ss',
        body: [IFACE, 'Greeting']
      });
      assert.ifError(err);
      // The shape people complain about -- and, under `plainValues`, the shape
      // that replaces it. Asserted explicitly on both sides because the whole
      // point of the next line is that it does not have to care.
      if (PLAIN_VALUES) {
        assert.strictEqual(result, 'hello');
      } else {
        assert.strictEqual(result[1][0], 'hello');
      }
      // the shape that survives 2.0
      assert.strictEqual(variantValue(result), 'hello');
    });

    it('toPlain turns GetAll into an object', async () => {
      const { err, result } = await invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: 'org.freedesktop.DBus.Properties',
        member: 'GetAll',
        signature: 's',
        body: [IFACE]
      });
      assert.ifError(err);
      assert.deepStrictEqual(toPlain(result), { Greeting: 'hello', Count: 7 });
    });

    it('a Variant can be written over the wire', async () => {
      const { err } = await invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: 'org.freedesktop.DBus.Properties',
        member: 'Set',
        signature: 'ssv',
        body: [IFACE, 'Greeting', new Variant('s', 'written with Variant')]
      });
      assert.ifError(err);
      assert.strictEqual(impl.Greeting, 'written with Variant');
    });

    it('errors carry message and dbusName', async () => {
      const { err } = await invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: IFACE,
        member: 'Fail'
      });
      assert.ok(err, 'expected an error');
      assert.strictEqual(err.message, 'deliberate failure');
      assert.strictEqual(err.dbusName, 'com.example.Error.Boom');
      assert.strictEqual(err.name, 'DBusError');
      // The point of the 0.6 accessors: code written against `message` and
      // `dbusName` then is untouched by the 0.7 change.
      assert.ok(err instanceof Error, 'is a real Error since 0.7');
      assert.deepStrictEqual(err.body, ['deliberate failure']);
    });

    it('falls back to the error name when the body is empty', async () => {
      const { err } = await invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: IFACE,
        member: 'Quiet'
      });
      assert.ok(err);
      assert.strictEqual(err.dbusName, 'com.example.Error.Silent');
      // used to be '' or undefined, which reads as "no error" at a glance
      assert.ok(err.message.length > 0, 'message should never be empty');
    });

    it('toClassicError reconstructs the pre-0.7 array', async () => {
      const { err } = await invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: IFACE,
        member: 'Fail'
      });
      const classic = toClassicError(err);
      assert.ok(Array.isArray(classic));
      assert.strictEqual(classic[0], 'deliberate failure');
      assert.strictEqual(classic.dbusName, 'com.example.Error.Boom');
      // including the way it serialised, which is what code that logs errors saw
      assert.strictEqual(JSON.stringify(classic), '["deliberate failure"]');
    });
  }
);
