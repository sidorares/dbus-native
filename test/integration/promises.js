// The promise API, end to end against a real dbus-daemon. Each case also
// asserts the callback form still behaves, since 0.6 must not break it.

const assert = require('assert');
const { EventEmitter } = require('events');
const dbus = require('../../index');
const { DBusError } = require('../../lib/errors');

const SERVICE = 'com.github.sidorares.dbusnative.Promises';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/Promises';
const IFACE = 'com.github.sidorares.dbusnative.PromisesIface';

const ifaceDesc = {
  name: IFACE,
  methods: {
    Echo: ['s', 's', ['input'], ['output']],
    Add: ['ii', 'i', ['a', 'b'], ['sum']],
    Nothing: ['', '', [], []],
    Fail: ['', '', [], []]
  },
  signals: {},
  properties: { Greeting: 's' }
};

describe('integration: promises', function () {
  this.timeout(10000);

  let serviceBus, clientBus, impl;

  before(async function () {
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) return this.skip();
    serviceBus = dbus.sessionBus();
    clientBus = dbus.sessionBus();

    impl = Object.assign(Object.create(EventEmitter.prototype), {
      Greeting: 'hello',
      Echo: input => input,
      Add: (a, b) => a + b,
      Nothing: () => null,
      Fail: () => {
        const err = new Error('deliberate failure');
        err.dbusName = 'com.example.Error.Boom';
        throw err;
      }
    });
    EventEmitter.call(impl);

    // getId() with no callback is itself a promise now
    await Promise.all([serviceBus.getId(), clientBus.getId()]);
    await serviceBus.requestName(SERVICE, 0);
    serviceBus.exportInterface(impl, OBJECT_PATH, ifaceDesc);
  });

  after(() => {
    if (serviceBus) serviceBus.connection.end();
    if (clientBus) clientBus.connection.end();
  });

  const call = (member, over = {}) => ({
    destination: SERVICE,
    path: OBJECT_PATH,
    interface: IFACE,
    member,
    ...over
  });

  describe('bus.invoke', () => {
    it('resolves with the reply value', async () => {
      const result = await clientBus.invoke(
        call('Echo', { signature: 's', body: ['round trip'] })
      );
      assert.strictEqual(result, 'round trip');
    });

    it('resolves with undefined when there is no reply body', async () => {
      assert.strictEqual(await clientBus.invoke(call('Nothing')), undefined);
    });

    it('rejects with a DBusError carrying dbusName and a stack', async () => {
      await assert.rejects(
        () => clientBus.invoke(call('Fail')),
        err => {
          assert.ok(err instanceof DBusError);
          assert.strictEqual(err.message, 'deliberate failure');
          assert.strictEqual(err.dbusName, 'com.example.Error.Boom');
          // The error is built in the socket read handler, so its own frames
          // are all library internals. The caller's frames are stitched on.
          assert.match(err.stack, /--- d-bus call made at ---/);
          assert.ok(
            err.stack
              .split('--- d-bus call made at ---')[1]
              .includes('integration/promises.js'),
            'stitched frames should name the calling file'
          );
          return true;
        }
      );
    });

    it('still supports the callback form unchanged', done => {
      clientBus.invoke(
        call('Echo', { signature: 's', body: ['callback'] }),
        (err, result) => {
          assert.ifError(err);
          assert.strictEqual(result, 'callback');
          done();
        }
      );
    });

    it('delivers a DBusError to callbacks on error', done => {
      clientBus.invoke(call('Fail'), err => {
        assert.ok(
          err instanceof dbus.DBusError,
          'callback error is a DBusError'
        );
        assert.strictEqual(err.message, 'deliberate failure');
        assert.strictEqual(err.dbusName, 'com.example.Error.Boom');
        assert.deepStrictEqual(err.body, ['deliberate failure']);
        assert.ok(err.stack, 'has a stack');
        done();
      });
    });
  });

  describe('bus meta methods', () => {
    it('getId resolves', async () => {
      assert.match(await clientBus.getId(), /^[0-9a-f]{32}$/);
    });

    it('listNames resolves with the well-known name', async () => {
      assert.ok((await clientBus.listNames()).includes(SERVICE));
    });

    it('nameHasOwner resolves', async () => {
      assert.strictEqual(await clientBus.nameHasOwner(SERVICE), true);
    });

    it('addMatch and removeMatch resolve', async () => {
      const rule = `type='signal',interface='${IFACE}'`;
      await clientBus.addMatch(rule);
      await clientBus.removeMatch(rule);
    });
  });

  describe('proxy objects', () => {
    it('getInterface resolves', async () => {
      const iface = await clientBus
        .getService(SERVICE)
        .getInterface(OBJECT_PATH, IFACE);
      assert.ok(iface);
    });

    it('method calls resolve', async () => {
      const iface = await clientBus
        .getService(SERVICE)
        .getInterface(OBJECT_PATH, IFACE);
      assert.strictEqual(await iface.Echo('via proxy'), 'via proxy');
      assert.strictEqual(await iface.Add(40, 2), 42);
    });

    it('method calls reject with a DBusError', async () => {
      const iface = await clientBus
        .getService(SERVICE)
        .getInterface(OBJECT_PATH, IFACE);
      await assert.rejects(() => iface.Fail(), { name: 'DBusError' });
    });

    it('property reads resolve', async () => {
      const iface = await clientBus
        .getService(SERVICE)
        .getInterface(OBJECT_PATH, IFACE);
      assert.strictEqual(await iface.Greeting(), 'hello');
    });

    it('property writes can be awaited via $writeProp', async () => {
      const iface = await clientBus
        .getService(SERVICE)
        .getInterface(OBJECT_PATH, IFACE);
      await iface.$writeProp('Greeting', 'written');
      assert.strictEqual(impl.Greeting, 'written');
    });

    it('still supports the callback form on methods', done => {
      clientBus
        .getService(SERVICE)
        .getInterface(OBJECT_PATH, IFACE, (err, iface) => {
          assert.ifError(err);
          iface.Echo('cb', (err, result) => {
            assert.ifError(err);
            assert.strictEqual(result, 'cb');
            done();
          });
        });
    });

    // Until 0.7 an interface the object does not implement resolved with
    // `undefined`, so the typo surfaced later as a property access on
    // undefined, somewhere unrelated -- #208.
    it('getInterface rejects for an interface the object lacks', async () => {
      await assert.rejects(
        () =>
          clientBus
            .getService(SERVICE)
            .getInterface(OBJECT_PATH, 'com.example.NotThere'),
        err => {
          assert.ok(err instanceof dbus.UnknownInterfaceError);
          assert.strictEqual(err.name, 'UnknownInterfaceError');
          assert.strictEqual(err.interfaceName, 'com.example.NotThere');
          assert.strictEqual(
            err.dbusName,
            'org.freedesktop.DBus.Error.UnknownInterface'
          );
          // the message lists what the object does implement
          assert.match(err.message, new RegExp(IFACE.replace(/\./g, '\\.')));
          return true;
        }
      );
    });

    it('getInterface errors the callback form too', done => {
      clientBus
        .getService(SERVICE)
        .getInterface(OBJECT_PATH, 'com.example.NotThere', (err, iface) => {
          assert.ok(err instanceof dbus.UnknownInterfaceError);
          assert.strictEqual(iface, undefined);
          done();
        });
    });

    it('as() throws rather than returning undefined', async () => {
      const obj = await clientBus.getService(SERVICE).getObject(OBJECT_PATH);
      assert.throws(() => obj.as('com.example.NotThere'), {
        name: 'UnknownInterfaceError'
      });
      assert.ok(obj.as(IFACE), 'an interface it does implement still works');
    });
  });

  it('reads like ordinary async code end to end', async () => {
    const iface = await clientBus
      .getService(SERVICE)
      .getInterface(OBJECT_PATH, IFACE);
    const [echoed, sum, names] = await Promise.all([
      iface.Echo('parallel'),
      iface.Add(1, 2),
      clientBus.listNames()
    ]);
    assert.strictEqual(echoed, 'parallel');
    assert.strictEqual(sum, 3);
    assert.ok(names.includes(SERVICE));
  });
});
