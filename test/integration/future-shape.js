// A canary for the 2.0 read shape.
//
// In 2.0 a variant unmarshals as the value itself and a dict as a plain
// object. The library reads its *own* messages through the same parser, so
// anything inside it that unwraps a variant by index breaks the moment that
// happens -- on every message, because a message header is `a(yv)` and its
// field values are variants.
//
// Nothing here implements the option. It patches the parser to produce the
// flipped shapes and then runs a real exchange over a real daemon, which is
// the only way to be sure the internals are ready before committing to it.
//
// If the parser's variant or dict representation changes, update the patch
// below alongside it -- a stale patch makes this test meaningless rather than
// loud.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const DBusBuffer = require('../../lib/dbus-buffer');
const parseSignature = require('../../lib/signature');
const { toPlain } = require('../../lib/values');
const dbus = require('../../index');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.FutureShape';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/FutureShape';
const IFACE = 'com.github.sidorares.dbusnative.FutureShapeIface';
const PROPS = 'org.freedesktop.DBus.Properties';

const ifaceDesc = {
  name: IFACE,
  methods: { Echo: ['s', 's', ['input'], ['output']] },
  signals: {},
  properties: { Greeting: 's' }
};

// node:test runs each file in its own process, so patching a prototype here
// cannot leak into the rest of the suite.
const original = {
  readVariant: DBusBuffer.prototype.readVariant,
  readArray: DBusBuffer.prototype.readArray
};

function useFutureShape() {
  DBusBuffer.prototype.readVariant = function () {
    const tree = parseSignature(this.readSimpleType('g'));
    const values = this.readStruct(tree);
    // 2.0: the value, not [tree, [value]]
    return values.length === 1 ? values[0] : values;
  };
  DBusBuffer.prototype.readArray = function (eleType, arrayBlobSize) {
    const result = original.readArray.call(this, eleType, arrayBlobSize);
    if (eleType.type !== '{') return result;
    // 2.0: a plain object, not an array of pairs
    const out = {};
    for (const [key, value] of result) out[key] = value;
    return out;
  };
}

describe(
  'integration: the 2.0 read shape',
  { timeout: 10000, skip: NO_BUS },
  () => {
    let serviceBus, clientBus, impl, iface;

    const whenReady = bus =>
      new Promise((resolve, reject) =>
        bus.getId(err => (err ? reject(err) : resolve()))
      );

    before(async () => {
      useFutureShape();

      serviceBus = dbus.sessionBus();
      clientBus = dbus.sessionBus();
      impl = Object.assign(Object.create(EventEmitter.prototype), {
        Greeting: 'hello',
        Echo: input => input
      });
      EventEmitter.call(impl);

      // Getting this far already proves header parsing survives: getId is a
      // real round trip whose reply headers were parsed in the flipped shape.
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
      DBusBuffer.prototype.readVariant = original.readVariant;
      DBusBuffer.prototype.readArray = original.readArray;
      if (serviceBus) serviceBus.connection.end();
      if (clientBus) clientBus.connection.end();
    });

    it('parses message headers', () => {
      // lib/message.js read every header field as field[1][1][0]; before this
      // was fixed the connection died on the first message with
      // "Cannot read properties of undefined".
      assert.match(clientBus.name, /^:\d+\.\d+$/);
    });

    it('completes a method call', async () => {
      assert.strictEqual(await iface.Echo('ping'), 'ping');
    });

    it('reads a property through the proxy', async () => {
      // lib/introspect.js $readProp indexed into the parsed signature tree.
      assert.strictEqual(await iface.Greeting(), 'hello');
    });

    it('writes a property', async () => {
      // lib/stdifaces.js took the value from body[2][1][0].
      await iface.$writeProp('Greeting', 'updated');
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.strictEqual(impl.Greeting, 'updated');
      assert.strictEqual(await iface.Greeting(), 'updated');
    });

    it('returns a{sv} as a plain object', async () => {
      const all = await clientBus.invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: PROPS,
        member: 'GetAll',
        signature: 's',
        body: [IFACE]
      });
      assert.ok(!Array.isArray(all), 'a dict is an object in this shape');
      assert.strictEqual(all.Greeting, 'updated');
    });

    it('leaves toPlain as the identity', async () => {
      const all = await clientBus.invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: PROPS,
        member: 'GetAll',
        signature: 's',
        body: [IFACE]
      });
      // The whole 0.6 forward-compatibility promise: code written against
      // toPlain() behaves the same before and after the change.
      assert.deepStrictEqual(toPlain(all), { Greeting: 'updated' });
    });

    it('round-trips a value read in this shape back onto the wire', async () => {
      // #335 made the marshaller take plain objects, so a value read here can
      // be sent straight back out without unwrapping.
      const all = await clientBus.invoke({
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: PROPS,
        member: 'GetAll',
        signature: 's',
        body: [IFACE]
      });
      const echoed = await iface.Echo(all.Greeting);
      assert.strictEqual(echoed, 'updated');
    });
  }
);
