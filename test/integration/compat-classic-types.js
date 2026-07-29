// `withClassicTypes` from dbus-native/compat, exercised against a real daemon.
//
// The interesting run is `npm run test:integration:2.0`, where the connection
// would otherwise read the 2.0 shapes: that is the only configuration in which
// this helper does anything at all. In the default run it is a no-op and these
// tests are still worth having, because they say what the shapes are either
// way.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const { variantValue, variantSignature } = require('../../lib/values');
const { withClassicTypes } = require('../../lib/compat');
const { sessionBus, PLAIN_VALUES } = require('../utils/shape');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Classic';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/Classic';
const IFACE = 'com.github.sidorares.dbusnative.ClassicIface';
const PROPS = 'org.freedesktop.DBus.Properties';

const ifaceDesc = {
  name: IFACE,
  methods: { Big: ['', 't', [], ['value']] },
  signals: {},
  properties: { Greeting: 's', Count: 'u' }
};

describe(
  'integration: withClassicTypes',
  { timeout: 10000, skip: NO_BUS },
  () => {
    let serviceBus, clientBus, modernBus;

    const whenReady = bus =>
      new Promise((resolve, reject) =>
        bus.getId(err => (err ? reject(err) : resolve()))
      );

    before(async () => {
      serviceBus = sessionBus();
      // Wrapped before the first call goes out, which is the documented rule.
      clientBus = withClassicTypes(sessionBus());
      // A second bus, deliberately not wrapped, to show the scope.
      modernBus = sessionBus();

      const impl = Object.assign(Object.create(EventEmitter.prototype), {
        Greeting: 'hello',
        Count: 7,
        Big: () => 9223372036854775807n
      });
      EventEmitter.call(impl);

      await Promise.all([
        whenReady(serviceBus),
        whenReady(clientBus),
        whenReady(modernBus)
      ]);
      await new Promise((resolve, reject) =>
        serviceBus.requestName(SERVICE, 0, err => {
          if (err) return reject(err);
          serviceBus.exportInterface(impl, OBJECT_PATH, ifaceDesc);
          resolve();
        })
      );
    });

    after(() => {
      for (const bus of [serviceBus, clientBus, modernBus])
        if (bus) bus.connection.end();
    });

    const get = (bus, property) =>
      bus.invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: PROPS,
        member: 'Get',
        signature: 'ss',
        body: [IFACE, property]
      });

    const getAll = bus =>
      bus.invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: PROPS,
        member: 'GetAll',
        signature: 's',
        body: [IFACE]
      });

    it('hands back a variant as [signatureTree, [value]]', async () => {
      const value = await get(clientBus, 'Greeting');
      assert.ok(Array.isArray(value), 'expected the classic wrapper');
      // The index chain 1.x code is full of, working verbatim.
      assert.strictEqual(value[1][0], 'hello');
      // And the real signature, not one inferred from the value -- which is why
      // this asks the parser rather than converting after the fact.
      assert.strictEqual(variantSignature(value), 's');
    });

    it('hands back a{sv} as an array of pairs', async () => {
      const all = await getAll(clientBus);
      assert.ok(Array.isArray(all), 'expected pairs, not an object');
      assert.deepStrictEqual(
        all.map(([key]) => key).sort(),
        ['Count', 'Greeting'].sort()
      );
      const greeting = all.find(([key]) => key === 'Greeting');
      assert.strictEqual(greeting[1][1][0], 'hello');
    });

    it("hands back 't' as a lossy number, as 1.x did", async () => {
      const value = await clientBus.invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: IFACE,
        member: 'Big'
      });
      assert.strictEqual(typeof value, 'number');
      // Restoring the old shape restores the old rounding. Documented, not a
      // regression: code that wants a Number is asking for this.
      assert.notStrictEqual(BigInt(value), 9223372036854775807n);
    });

    it('leaves an unwrapped bus on this run’s own shapes', async () => {
      const value = await get(modernBus, 'Greeting');
      if (PLAIN_VALUES) {
        assert.strictEqual(value, 'hello', 'the wrapper leaked to another bus');
      } else {
        assert.strictEqual(value[1][0], 'hello');
      }
    });

    it('is what variantValue reads either way', async () => {
      assert.strictEqual(
        variantValue(await get(clientBus, 'Greeting')),
        'hello'
      );
      assert.strictEqual(
        variantValue(await get(modernBus, 'Greeting')),
        'hello'
      );
    });

    it('rejects something that is not a bus', () => {
      assert.throws(() => withClassicTypes({}), /expects a bus/);
      assert.throws(() => withClassicTypes(undefined), /expects a bus/);
    });
  }
);
