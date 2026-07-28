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
          assert.ok(err.stack.includes('promises.js'), 'stack reaches caller');
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

    it('still delivers the raw array to callbacks on error', done => {
      clientBus.invoke(call('Fail'), err => {
        assert.ok(Array.isArray(err), 'callback error is still the body array');
        assert.strictEqual(err[0], 'deliberate failure');
        assert.strictEqual(err.dbusName, 'com.example.Error.Boom');
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
