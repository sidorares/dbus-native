// What a service method may return, and what happens when it returns the
// wrong thing.
//
// The interface descriptor has always accepted an output signature with
// several complete types -- `['', 'si', [], ['name', 'count']]` -- and the
// introspection XML advertised two out arguments. But the reply body was
// always `[result]`, one value, so that shape was expressible, promised to
// callers, and impossible to satisfy. Worse, the marshalling failure threw
// out of a promise continuation and took the service process down, so the
// caller waited for a reply that could never arrive. See #114.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const { sessionBus } = require('../utils/shape');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Returns';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/Returns';
const IFACE = 'com.github.sidorares.dbusnative.ReturnsIface';

const ifaceDesc = {
  name: IFACE,
  methods: {
    Void: ['', '', [], []],
    One: ['', 's', [], ['only']],
    Struct: ['', '(si)', [], ['pair']],
    Two: ['', 'si', [], ['name', 'count']],
    Four: ['', 'ssss', [], ['name', 'vendor', 'version', 'spec']],
    ReturnsNull: ['', 's', [], ['only']],
    // the three ways a handler can be wrong
    NotAnArray: ['', 'si', [], ['name', 'count']],
    TooFew: ['', 'si', [], ['name', 'count']],
    WrongScalar: ['', 's', [], ['only']]
  },
  signals: {},
  properties: {}
};

describe(
  'integration: method return values',
  { timeout: 10000, skip: NO_BUS },
  () => {
    let serviceBus, clientBus, iface;

    const whenReady = bus =>
      new Promise((resolve, reject) =>
        bus.getId(err => (err ? reject(err) : resolve()))
      );

    before(async () => {
      serviceBus = sessionBus();
      clientBus = sessionBus();

      const impl = Object.assign(Object.create(EventEmitter.prototype), {
        Void: () => undefined,
        One: () => 'x',
        Struct: () => ['x', 1],
        Two: () => ['x', 1],
        Four: () => ['dbus-native', 'me', '1.0', '1.2'],
        ReturnsNull: () => null,
        NotAnArray: () => 'oops',
        TooFew: () => ['only one'],
        WrongScalar: () => 42
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

    describe('what a handler may return', () => {
      it('nothing, for an empty output signature', async () => {
        assert.strictEqual(await iface.Void(), undefined);
      });

      it('a single value', async () => {
        assert.strictEqual(await iface.One(), 'x');
      });

      it('an array for a struct, which is one value', async () => {
        assert.deepStrictEqual(await iface.Struct(), ['x', 1]);
      });

      it('an array for two out arguments, which used to be impossible', async () => {
        assert.deepStrictEqual(await iface.Two(), ['x', 1]);
      });

      it('four out arguments, as org.freedesktop.Notifications declares', async () => {
        assert.deepStrictEqual(await iface.Four(), [
          'dbus-native',
          'me',
          '1.0',
          '1.2'
        ]);
      });

      it('null, which still means no reply body at all', async () => {
        assert.strictEqual(await iface.ReturnsNull(), undefined);
      });
    });

    describe('when a handler returns the wrong thing', () => {
      // Each of these used to be an unhandled rejection that killed the
      // service, so the caller hung rather than being told.
      const cases = [
        ['NotAnArray', 'declares two values but returns a string'],
        ['TooFew', 'declares two values but returns one'],
        ['WrongScalar', 'declares a string but returns a number']
      ];

      for (const [method, why] of cases) {
        it(`answers with an error when it ${why}`, async () => {
          const err = await iface[method]().then(
            () => null,
            e => e
          );
          assert.ok(err, `${method} should have failed`);
          assert.strictEqual(err.dbusName, 'org.freedesktop.DBus.Error.Failed');
          assert.match(err.message, /does not match its declared output/);
          // the message names the method, since a service may export many
          assert.match(err.message, new RegExp(`${IFACE}\\.${method}`));
        });
      }

      it('leaves the service alive and serving', async () => {
        const names = await clientBus.listNames();
        assert.ok(names.includes(SERVICE), 'service is still on the bus');
        assert.strictEqual(await iface.One(), 'x');
      });
    });

    it('advertises the out arguments it can now actually produce', async () => {
      const xml = await clientBus
        .getService(SERVICE)
        .getInterface(OBJECT_PATH, 'org.freedesktop.DBus.Introspectable')
        .then(i => i.Introspect());
      const method = xml.match(/<method name="Two">[\s\S]*?<\/method>/)[0];
      assert.match(method, /<arg type="s" name="name" direction="out"/);
      assert.match(method, /<arg type="i" name="count" direction="out"/);
    });
  }
);
