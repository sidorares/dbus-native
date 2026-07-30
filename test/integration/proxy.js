// bus.proxy(): the remote object, as an object.
//
// The existing surface makes you name the interface before you can call
// anything. This resolves the member against what the object introspected as,
// which means the interesting cases are the ones where that resolution is
// ambiguous or where the name collides with something JavaScript expects.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const util = require('util');
const { EventEmitter } = require('events');
const { sessionBus } = require('../utils/shape');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Proxied';
const PATH = '/com/github/sidorares/dbusnative/Proxied';
const ALPHA = 'com.github.sidorares.dbusnative.Alpha';
const BETA = 'com.github.sidorares.dbusnative.Beta';

// Two interfaces on one object, deliberately sharing `Shared` and `Colour` --
// which is legal, and the case a proxy has to refuse to guess about.
const alphaDesc = {
  name: ALPHA,
  methods: {
    Echo: ['s', 's', ['in'], ['out']],
    Shared: ['', 's', [], ['who']],
    // A member named `then`. Legal on the wire, and lethal to a naive proxy.
    then: ['', 's', [], ['out']]
  },
  signals: { Pinged: ['s', 'payload'] },
  properties: { Greeting: 's', Colour: 's' }
};

const betaDesc = {
  name: BETA,
  methods: { Shared: ['', 's', [], ['who']] },
  signals: {},
  properties: { Level: 'd', Colour: 's' }
};

describe('integration: bus.proxy', { timeout: 15000, skip: NO_BUS }, () => {
  let serviceBus, clientBus, impl, proxy;

  const whenReady = bus =>
    new Promise((resolve, reject) =>
      bus.getId(err => (err ? reject(err) : resolve()))
    );

  before(async () => {
    serviceBus = sessionBus();
    clientBus = sessionBus();
    await Promise.all([whenReady(serviceBus), whenReady(clientBus)]);
    await new Promise((resolve, reject) =>
      serviceBus.requestName(SERVICE, 0, err => (err ? reject(err) : resolve()))
    );

    impl = Object.assign(Object.create(EventEmitter.prototype), {
      Greeting: 'hello',
      Colour: 'red',
      Level: 0.5,
      Echo: input => input,
      Shared: () => 'alpha',
      then: () => 'a member really called then'
    });
    EventEmitter.call(impl);
    serviceBus.exportInterface(impl, PATH, alphaDesc);

    const beta = Object.assign(Object.create(EventEmitter.prototype), {
      Level: 0.5,
      Colour: 'blue',
      Shared: () => 'beta'
    });
    EventEmitter.call(beta);
    serviceBus.exportInterface(beta, PATH, betaDesc);

    proxy = await clientBus.proxy(SERVICE, PATH);
  });

  after(async () => {
    for (const bus of [serviceBus, clientBus]) if (bus) await bus.close();
  });

  describe('methods', () => {
    it('calls one without naming its interface', async () => {
      assert.strictEqual(await proxy.Echo('round trip'), 'round trip');
    });

    it('reaches the standard interfaces too', async () => {
      // Peer and Introspectable are on every object, so they come for free.
      const id = await proxy.GetMachineId();
      assert.match(id, /^[0-9a-f]{32}$/);
    });

    it('refuses to guess when two interfaces declare the same name', () => {
      assert.throws(() => proxy.Shared, {
        message: new RegExp(
          `Method "Shared" is declared by more than one interface at ${PATH}`
        )
      });
      // And it names both, so the fix is obvious rather than a hunt.
      assert.throws(() => proxy.Shared, new RegExp(ALPHA));
      assert.throws(() => proxy.Shared, new RegExp(BETA));
    });

    it('is undefined for a name the object does not declare', () => {
      assert.strictEqual(proxy.NoSuchMethod, undefined);
      assert.strictEqual('NoSuchMethod' in proxy, false);
      assert.strictEqual('Echo' in proxy, true);
    });
  });

  describe('the `then` hazard', () => {
    // BIG_FUTURE_PLANS 2.3. A get trap that answers every name with a function
    // makes `await proxy` look up .then, call it, and wait forever.
    it('never manufactures a then, even for a member really called then', () => {
      assert.strictEqual(proxy.then, undefined);
    });

    it('can be awaited without hanging', async () => {
      const same = await proxy;
      assert.strictEqual(same, proxy, 'await resolved to the proxy itself');
    });

    it('survives being returned from an async function', async () => {
      // The subtler form: returning a thenable from async makes the runtime
      // await it for you, so this hangs even if nobody wrote `await proxy`.
      const returned = await (async () => proxy)();
      assert.strictEqual(returned, proxy);
    });

    it('still reaches the real member through $as', async () => {
      const alpha = proxy.$as(ALPHA);
      assert.strictEqual(await alpha.then(), 'a member really called then');
    });
  });

  describe('{ interface } narrows it', () => {
    it('resolves a shared name once only one interface is in scope', async () => {
      const alpha = await clientBus.proxy(SERVICE, PATH, { interface: ALPHA });
      assert.strictEqual(await alpha.Shared(), 'alpha');

      const beta = await clientBus.proxy(SERVICE, PATH, { interface: BETA });
      assert.strictEqual(await beta.Shared(), 'beta');
    });

    it('hides the other interfaces entirely', async () => {
      const beta = await clientBus.proxy(SERVICE, PATH, { interface: BETA });
      assert.deepStrictEqual(beta.$interfaces, [BETA]);
      assert.strictEqual(beta.Echo, undefined);
    });

    it('rejects an interface the object does not have', async () => {
      await assert.rejects(
        () => clientBus.proxy(SERVICE, PATH, { interface: 'com.example.Nope' }),
        /No interface "com\.example\.Nope"/
      );
    });
  });

  describe('$props', () => {
    it('reads one as a promise', async () => {
      assert.strictEqual(await proxy.$props.Greeting, 'hello');
      assert.strictEqual(await proxy.$props.Level, 0.5);
    });

    it('reads them all in one round trip, flattened', async () => {
      const all = await proxy.$props.$all();
      assert.strictEqual(all.Greeting, 'hello');
      assert.strictEqual(all.Level, 0.5);
    });

    it('writes one, and several', async () => {
      await proxy.$props.$set('Greeting', 'written');
      assert.strictEqual(impl.Greeting, 'written');
      assert.strictEqual(await proxy.$props.Greeting, 'written');

      await proxy.$props.$set({ Greeting: 'batched' });
      assert.strictEqual(impl.Greeting, 'batched');
    });

    it('refuses assignment rather than losing the failure', () => {
      // `obj.x = v` evaluates to v, so a rejected write has nowhere to go.
      assert.throws(() => {
        proxy.$props.Greeting = 'nope';
      }, /Assigning to a property cannot report failure/);
    });

    it('refuses to guess a property two interfaces declare', () => {
      assert.throws(() => proxy.$props.Colour, /more than one interface/);
    });

    it('is undefined for a property that is not there', () => {
      assert.strictEqual(proxy.$props.Nope, undefined);
    });
  });

  describe('signals', () => {
    it('subscribes without naming the interface', async () => {
      const got = new Promise(resolve => proxy.$on('Pinged', resolve));
      await new Promise(resolve => setTimeout(resolve, 120));
      impl.emit('Pinged', 'payload');
      assert.strictEqual(await got, 'payload');
    });

    it('unsubscribes', async () => {
      let count = 0;
      const handler = () => count++;
      proxy.$on('Pinged', handler);
      await new Promise(resolve => setTimeout(resolve, 120));
      impl.emit('Pinged', 'one');
      await new Promise(resolve => setTimeout(resolve, 120));
      proxy.$off('Pinged', handler);
      impl.emit('Pinged', 'two');
      await new Promise(resolve => setTimeout(resolve, 120));
      assert.strictEqual(count, 1);
    });

    it('says so for a signal that does not exist', () => {
      assert.throws(() => proxy.$on('Nope', () => {}), /No signal "Nope"/);
    });
  });

  describe('what it looks like', () => {
    it('inspects as the object it stands for, not the connection', () => {
      // Without a custom inspect this prints $bus and walks the whole socket.
      const shown = util.inspect(proxy);
      assert.match(shown, /^DBusProxy/);
      assert.ok(shown.includes(SERVICE));
      assert.ok(shown.includes(PATH));
      assert.match(shown, /methods: .*Echo/);
      assert.match(shown, /properties: .*Greeting/);
      assert.match(shown, /signals: .*Pinged/);
      assert.ok(!shown.includes('connection'), 'no internals');
    });

    it('reports what it is standing in for', () => {
      assert.strictEqual(proxy.$service, SERVICE);
      assert.strictEqual(proxy.$path, PATH);
      assert.ok(proxy.$interfaces.includes(ALPHA));
      assert.ok(proxy.$interfaces.includes(BETA));
    });

    it('refuses assignment of a method name', () => {
      assert.throws(() => {
        proxy.Echo = () => {};
      }, /Cannot assign to "Echo"/);
    });
  });
});
