// Signals through an introspected proxy, against a real dbus-daemon.
//
// The client half of the properties work in 0.9: a service emits
// PropertiesChanged, and this is what it takes to receive one.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const dbus = require('../../index');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Signals';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/Signals';
const IFACE = 'com.github.sidorares.dbusnative.SignalsIface';
const PROPS = 'org.freedesktop.DBus.Properties';

const ifaceDesc = {
  name: IFACE,
  methods: {},
  signals: {
    Alpha: ['s', 'which'],
    Beta: ['s', 'which'],
    Detailed: ['si', 'who', 'times'],
    Bare: ['']
  },
  properties: {
    Greeting: 's'
  }
};

describe('integration: proxy signals', { timeout: 10000, skip: NO_BUS }, () => {
  let serviceBus, clientBus, impl, iface, props;

  const whenReady = bus =>
    new Promise((resolve, reject) =>
      bus.getId(err => (err ? reject(err) : resolve()))
    );

  // Every subscription below is awaited, so nothing here depends on a signal
  // racing an in-flight AddMatch.
  const nextSignal = (target, name) =>
    new Promise(resolve => {
      const cb = (...args) => {
        target.off(name, cb);
        resolve(args);
      };
      target.on(name, cb);
    });

  before(async () => {
    serviceBus = dbus.sessionBus();
    clientBus = dbus.sessionBus();
    impl = Object.assign(Object.create(EventEmitter.prototype), {
      Greeting: 'hello'
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

    const service = clientBus.getService(SERVICE);
    iface = await service.getInterface(OBJECT_PATH, IFACE);
    props = await service.getInterface(OBJECT_PATH, PROPS);
  });

  after(() => {
    serviceBus.connection.end();
    clientBus.connection.end();
  });

  describe('introspection', () => {
    it('discovers the signals the service declares', () => {
      assert.deepStrictEqual(iface.$signals, {
        Alpha: ['s', 'which'],
        Beta: ['s', 'which'],
        Detailed: ['si', 'who', 'times'],
        Bare: ['']
      });
    });

    it('round-trips the descriptor the service was exported with', () => {
      assert.deepStrictEqual(iface.$signals, ifaceDesc.signals);
    });

    it('discovers PropertiesChanged on the standard interface', () => {
      assert.deepStrictEqual(props.$signals.PropertiesChanged, [
        'sa{sv}as',
        'interface_name',
        'changed_properties',
        'invalidated_properties'
      ]);
    });
  });

  describe('delivery', () => {
    it('delivers a signal with its arguments', async () => {
      const received = nextSignal(iface, 'Alpha');
      await new Promise(resolve => setTimeout(resolve, 50));
      impl.emit('Alpha', 'first');
      assert.deepStrictEqual(await received, ['first']);
    });

    it('delivers multiple arguments in order', async () => {
      await new Promise((resolve, reject) => {
        const cb = (...args) => {
          iface.off('Detailed', cb);
          try {
            assert.deepStrictEqual(args, ['bob', 3]);
            resolve();
          } catch (e) {
            reject(e);
          }
        };
        iface
          .$subscribe('Detailed', cb)
          .then(() => impl.emit('Detailed', 'bob', 3), reject);
      });
    });

    it('delivers a signal that carries no arguments', async () => {
      await new Promise((resolve, reject) => {
        const cb = (...args) => {
          iface.off('Bare', cb);
          try {
            assert.deepStrictEqual(args, []);
            resolve();
          } catch (e) {
            reject(e);
          }
        };
        iface.$subscribe('Bare', cb).then(() => impl.emit('Bare'), reject);
      });
    });

    it('is subscribed as soon as $subscribe resolves', async () => {
      let count = 0;
      const cb = () => count++;
      await iface.$subscribe('Alpha', cb);
      impl.emit('Alpha', 'immediately');
      await new Promise(resolve => setTimeout(resolve, 200));
      await iface.$unsubscribe('Alpha', cb);
      assert.strictEqual(count, 1, 'signal emitted right after subscribing');
    });
  });

  describe('unsubscribing', () => {
    it('stops delivering after off()', async () => {
      let count = 0;
      const cb = () => count++;
      await iface.$subscribe('Alpha', cb);
      await iface.$unsubscribe('Alpha', cb);

      impl.emit('Alpha', 'ignored');
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.strictEqual(count, 0);
    });

    // Regression: removing the last listener of one signal used to discard the
    // bookkeeping for every other signal on the interface, so this second
    // off() removed nothing and Beta kept firing forever.
    it('can unsubscribe one signal after another was fully removed', async () => {
      let beta = 0;
      const onAlpha = () => {};
      const onBeta = () => beta++;

      await iface.$subscribe('Alpha', onAlpha);
      await iface.$subscribe('Beta', onBeta);
      await iface.$unsubscribe('Alpha', onAlpha);
      await iface.$unsubscribe('Beta', onBeta);

      impl.emit('Beta', 'ignored');
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.strictEqual(beta, 0);
      assert.strictEqual(iface.listenerCount('Beta'), 0);
    });

    it('fires a once() listener exactly once', async () => {
      let count = 0;
      iface.once('Alpha', () => count++);
      await new Promise(resolve => setTimeout(resolve, 100));

      impl.emit('Alpha', 'one');
      await new Promise(resolve => setTimeout(resolve, 100));
      impl.emit('Alpha', 'two');
      await new Promise(resolve => setTimeout(resolve, 200));

      assert.strictEqual(count, 1);
      assert.strictEqual(iface.listenerCount('Alpha'), 0);
    });
  });

  describe('PropertiesChanged', () => {
    it('reaches a subscriber on the standard Properties interface', async () => {
      const received = nextSignal(props, 'PropertiesChanged');
      await new Promise(resolve => setTimeout(resolve, 50));

      serviceBus.emitPropertiesChanged(OBJECT_PATH, IFACE, {
        Greeting: 'hello again'
      });

      const [ifaceName, changed, invalidated] = await received;
      assert.strictEqual(ifaceName, IFACE);
      assert.deepStrictEqual(invalidated, []);
      // Still the classic variant shape: [name, [signatureTree, [value]]].
      assert.strictEqual(changed[0][0], 'Greeting');
      assert.strictEqual(changed[0][1][1][0], 'hello again');
    });

    it('is emitted by Properties.Set as well', async () => {
      const received = nextSignal(props, 'PropertiesChanged');
      await new Promise(resolve => setTimeout(resolve, 50));

      await props.Set(IFACE, 'Greeting', ['s', 'set by the client']);

      const [, changed] = await received;
      assert.strictEqual(changed[0][0], 'Greeting');
      assert.strictEqual(changed[0][1][1][0], 'set by the client');
    });
  });
});
