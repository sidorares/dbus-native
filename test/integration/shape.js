// Proves the run is testing the shape it claims to be testing.
//
// `npm run test:integration:2.0` is only worth anything if DBUS_TEST_SHAPE
// actually reaches the tests -- it travels through two `npm run` hops and a
// wrapper process to get here. If a rename or a lost `env` spread ever breaks
// that chain the whole suite goes green while exercising nothing new, which is
// worse than a red one. So the shape is asserted against a real daemon rather
// than assumed.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const { variantValue, variantSignature, Variant } = require('../../lib/values');
const { sessionBus, VARIANTS, RETURN_BIGINT } = require('../utils/shape');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Shape';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/Shape';
const IFACE = 'com.github.sidorares.dbusnative.ShapeIface';
const PROPS = 'org.freedesktop.DBus.Properties';

const ifaceDesc = {
  name: IFACE,
  methods: { Big: ['', 't', [], ['value']] },
  signals: {},
  properties: { Greeting: 's' }
};

describe(
  'integration: the shape under test',
  { timeout: 10000, skip: NO_BUS },
  () => {
    let serviceBus, clientBus;

    const whenReady = bus =>
      new Promise((resolve, reject) =>
        bus.getId(err => (err ? reject(err) : resolve()))
      );

    before(async () => {
      serviceBus = sessionBus();
      clientBus = sessionBus();
      const impl = Object.assign(Object.create(EventEmitter.prototype), {
        Greeting: 'hello',
        // 2^63, which no Number can hold exactly.
        Big: () => 9223372036854775808n
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
      for (const bus of [serviceBus, clientBus]) if (bus) bus.connection.end();
    });

    const get = () =>
      clientBus.invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: PROPS,
        member: 'Get',
        signature: 'ss',
        body: [IFACE, 'Greeting']
      });

    it(`reads a variant in the '${VARIANTS}' shape`, async () => {
      const value = await get();
      if (VARIANTS === 'plain') {
        assert.strictEqual(value, 'hello', 'plainValues did not take effect');
        // The one thing this shape gives up.
        assert.strictEqual(variantSignature(value), undefined);
      } else if (VARIANTS === 'wrap') {
        assert.ok(
          value instanceof Variant,
          "variants:'wrap' did not take effect"
        );
        assert.strictEqual(value.signature, 's');
        assert.strictEqual(value.value, 'hello');
      } else {
        assert.ok(Array.isArray(value), 'expected the classic [tree, [value]]');
        assert.strictEqual(variantSignature(value), 's');
      }
      // Whichever it was, the accessor reads it. This is the promise itself.
      assert.strictEqual(variantValue(await get()), 'hello');
    });

    it(`reads 't' as a ${RETURN_BIGINT ? 'bigint' : 'number'}`, async () => {
      const value = await clientBus.invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: IFACE,
        member: 'Big'
      });
      assert.strictEqual(
        typeof value,
        RETURN_BIGINT ? 'bigint' : 'number',
        'returnBigInt did not take effect'
      );
      if (RETURN_BIGINT) assert.strictEqual(value, 9223372036854775808n);
    });
  }
);
