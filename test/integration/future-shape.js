// The 0.14.0 read shape, on a real daemon, with `plainValues` actually on.
//
// A variant unmarshals as the value itself and a string-keyed dict as a plain
// object. The library reads its *own* messages through the same parser, so
// anything inside it that unwraps a variant by index breaks the moment that
// happens -- on every message, because a message header is `a(yv)` and its
// field values are variants. That is what this exists to catch.
//
// It used to monkey-patch the parser to simulate the shapes, because the
// option did not exist yet. It does now, so the simulation is gone and this
// exercises the real thing.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
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

describe(
  'integration: the 0.14.0 read shape',
  { timeout: 10000, skip: NO_BUS },
  () => {
    let serviceBus, clientBus, impl, iface;

    const whenReady = bus =>
      new Promise((resolve, reject) =>
        bus.getId(err => (err ? reject(err) : resolve()))
      );

    before(async () => {
      // Both sides opt in: a service reads its own arguments through the
      // same parser, so the shape has to work in both directions.
      serviceBus = dbus.sessionBus({ plainValues: true });
      clientBus = dbus.sessionBus({ plainValues: true });
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
