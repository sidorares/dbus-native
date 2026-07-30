// Passing a plain object where a dict is expected, over a real daemon.
//
// The unit tests in test/js-types.js check the bytes; this checks that a
// service actually receives what the object described, which is the question
// behind #3, #91 and #132.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const { Variant, toPlain, variantSignature } = require('../../lib/values');
const { sessionBus, VARIANTS } = require('../utils/shape');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Dicts';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/Dicts';
const IFACE = 'com.github.sidorares.dbusnative.DictsIface';

const ifaceDesc = {
  name: IFACE,
  methods: {
    // takes a dict, hands back what it saw as a printable string
    Describe: ['a{sv}', 's', ['options'], ['description']],
    // takes a dict and echoes it straight back
    Echo: ['a{sv}', 'a{sv}', ['options'], ['same']],
    Strings: ['a{ss}', 's', ['options'], ['description']]
  },
  signals: {},
  properties: {}
};

describe(
  'integration: dicts from plain objects',
  { timeout: 10000, skip: NO_BUS },
  () => {
    let serviceBus, clientBus, iface, received;

    const whenReady = bus =>
      new Promise((resolve, reject) =>
        bus.getId(err => (err ? reject(err) : resolve()))
      );

    before(async () => {
      serviceBus = sessionBus();
      clientBus = sessionBus();

      const impl = Object.assign(Object.create(EventEmitter.prototype), {
        Describe(options) {
          received = options;
          return JSON.stringify(toPlain(options));
        },
        Echo(options) {
          received = options;
          // Handed straight back, in the shape the reader produced it.
          return options;
        },
        Strings(options) {
          received = options;
          return JSON.stringify(toPlain(options));
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

      iface = await clientBus
        .getService(SERVICE)
        .getInterface(OBJECT_PATH, IFACE);
    });

    after(() => {
      serviceBus.connection.end();
      clientBus.connection.end();
    });

    it('delivers a plain object as a{sv}', async () => {
      const description = await iface.Describe({
        Name: 'widget',
        Count: 3,
        Enabled: true,
        Ratio: 0.5
      });
      assert.deepStrictEqual(JSON.parse(description), {
        Name: 'widget',
        Count: 3,
        Enabled: true,
        Ratio: 0.5
      });
    });

    it('delivers a nested object', async () => {
      const description = await iface.Describe({
        outer: { inner: 'value', n: 1 }
      });
      assert.deepStrictEqual(JSON.parse(description), {
        outer: { inner: 'value', n: 1 }
      });
    });

    it('delivers an array value', async () => {
      const description = await iface.Describe({ tags: ['a', 'b'] });
      assert.deepStrictEqual(JSON.parse(description), { tags: ['a', 'b'] });
    });

    it('the service sees the values the client asked for', async () => {
      await iface.Describe({
        n: 1,
        d: 1.5,
        s: 'x',
        b: true,
        u: new Variant('u', 9)
      });
      assert.deepStrictEqual(toPlain(received), {
        n: 1,
        d: 1.5,
        s: 'x',
        b: true,
        u: 9
      });
    });

    // A variant's signature is only recoverable from a shape that carries it.
    // `variants: 'wrap'` is how a service asks for one: it is the only way to
    // find out what types an a{sv} argument arrived with, and until it existed
    // the answer was "read the parser's internal tree, or do without".
    it(`the service sees the types too, under '${VARIANTS}'`, () => {
      if (VARIANTS === 'plain') {
        assert.strictEqual(
          variantSignature(Object.values(received)[0]),
          undefined,
          'this is the shape that trades the signature away'
        );
        return;
      }
      // Pairs under 'tree', a plain object under 'wrap' -- the dict shape is
      // governed by plainValues, not by this option.
      const entries = Array.isArray(received)
        ? received
        : Object.entries(received);
      const signatures = {};
      for (const [key, value] of entries) {
        signatures[key] = variantSignature(value);
      }
      assert.deepStrictEqual(signatures, {
        n: 'i',
        d: 'd',
        s: 's',
        b: 'b',
        u: 'u'
      });
    });

    it('round-trips a dict through a service that echoes it', async () => {
      const sent = { a: 1, b: 'two' };
      const back = await iface.Echo(sent);
      assert.deepStrictEqual(toPlain(back), sent);
    });

    it('works for a dict of plain strings', async () => {
      const description = await iface.Strings({ a: 'x', b: 'y' });
      assert.deepStrictEqual(JSON.parse(description), { a: 'x', b: 'y' });
    });

    it('still accepts the array-of-pairs form', async () => {
      const description = await iface.Describe([
        ['Name', new Variant('s', 'widget')]
      ]);
      assert.deepStrictEqual(JSON.parse(description), { Name: 'widget' });
    });

    it('reports an unrepresentable value without sending anything', async () => {
      await assert.rejects(
        async () => iface.Describe({ when: new Date() }),
        /wrap it in a Variant/
      );
      // the connection is still usable
      assert.deepStrictEqual(JSON.parse(await iface.Describe({ ok: 1 })), {
        ok: 1
      });
    });
  }
);
