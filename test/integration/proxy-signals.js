// proxy.$watch() and proxy.$signal(), against a real bus.
//
// BIG_FUTURE_PLANS 2.4. The callback form is primary and the iterable is the
// convenience -- the reverse of the original sketch, because async iterator
// helpers are still not in Node, so `.map()`/`.filter()`/`.take()` do not exist
// on these streams and most of what made iteration attractive is missing.
//
// The queue policy is unit-tested in test/signal-stream.js without a bus. What
// needs a daemon is that the match rule really goes on and really comes off.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const { sessionBus } = require('../utils/shape');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Streamed';
const PATH = '/com/github/sidorares/dbusnative/Streamed';
const IFACE = 'com.github.sidorares.dbusnative.StreamedIface';

const settle = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));

describe('integration: proxy signals', { timeout: 20000, skip: NO_BUS }, () => {
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

    impl = Object.assign(Object.create(EventEmitter.prototype), {});
    EventEmitter.call(impl);
    serviceBus.exportInterface(impl, PATH, {
      name: IFACE,
      methods: {},
      signals: { Ticked: ['s', 'label'], Paired: ['si', 'name', 'count'] },
      properties: {}
    });

    proxy = await clientBus.proxy(SERVICE, PATH);
  });

  after(async () => {
    for (const bus of [serviceBus, clientBus]) if (bus) await bus.close();
  });

  describe('$watch', () => {
    it('resolves once the match rule is really in place', async () => {
      // $on cannot report that, which is the reason this exists: a signal
      // emitted immediately after subscribing used to be a coin flip.
      const seen = [];
      const sub = await proxy.$watch('Ticked', label => seen.push(label));
      impl.emit('Ticked', 'immediately after');
      await settle();
      assert.deepStrictEqual(seen, ['immediately after']);
      await sub.remove();
    });

    it('stops delivering once removed', async () => {
      const seen = [];
      const sub = await proxy.$watch('Ticked', label => seen.push(label));
      impl.emit('Ticked', 'before');
      await settle();
      await sub.remove();
      assert.strictEqual(sub.removed, true);
      impl.emit('Ticked', 'after');
      await settle();
      assert.deepStrictEqual(seen, ['before']);
    });

    it('removes through Symbol.asyncDispose, and only once', async () => {
      const sub = await proxy.$watch('Ticked', () => {});
      await sub[Symbol.asyncDispose]();
      await sub[Symbol.asyncDispose]();
      assert.strictEqual(sub.removed, true);
    });

    it('says so for a signal the object does not declare', async () => {
      await assert.rejects(
        () => proxy.$watch('Nope', () => {}),
        /No signal "Nope"/
      );
    });
  });

  describe('$signal', () => {
    it('iterates, and breaking removes the subscription', async () => {
      const stream = proxy.$signal('Ticked');
      const seen = [];

      const loop = (async () => {
        for await (const [label] of stream) {
          seen.push(label);
          if (label === 'stop') break;
        }
      })();

      await settle();
      impl.emit('Ticked', 'one');
      await settle();
      impl.emit('Ticked', 'stop');
      await loop;

      assert.deepStrictEqual(seen, ['one', 'stop']);

      // The rule is off: a later signal reaches nothing. Checked through a
      // fresh subscription rather than by inspecting internals.
      const after = [];
      const sub = await proxy.$watch('Ticked', l => after.push(l));
      impl.emit('Ticked', 'later');
      await settle();
      assert.deepStrictEqual(after, ['later'], 'the bus still works');
      await sub.remove();
    });

    it('destructures a multi-argument signal', async () => {
      const stream = proxy.$signal('Paired');
      const seen = [];
      const loop = (async () => {
        for await (const [name, count] of stream) {
          seen.push([name, count]);
          break;
        }
      })();
      await settle();
      impl.emit('Paired', 'widget', 7);
      await loop;
      assert.deepStrictEqual(seen, [['widget', 7]]);
    });

    it('ends on an AbortSignal', async () => {
      const ac = new AbortController();
      const stream = proxy.$signal('Ticked', { signal: ac.signal });
      const seen = [];
      const loop = (async () => {
        for await (const [label] of stream) seen.push(label);
      })();

      await settle();
      impl.emit('Ticked', 'before abort');
      await settle();
      ac.abort();
      await loop;

      assert.deepStrictEqual(seen, ['before abort']);
    });

    it('refuses an unbounded queue', () => {
      // The one option that is deliberately unavailable.
      assert.throws(
        () => proxy.$signal('Ticked', { queue: 0 }),
        /queue must be a positive integer or 'latest'/
      );
      assert.throws(
        () => proxy.$signal('Ticked', { queue: Infinity }),
        /queue must be a positive integer or 'latest'/
      );
    });

    it('keeps the most recent when the consumer is slow', async () => {
      const stream = proxy.$signal('Ticked', { queue: 2 });
      const iterator = stream[Symbol.asyncIterator]();

      // Take one, to get the subscription established.
      const first = iterator.next();
      await settle();
      impl.emit('Ticked', 'a');
      assert.deepStrictEqual((await first).value, ['a']);

      // Four more with nobody waiting, against a bound of two.
      for (const label of ['b', 'c', 'd', 'e']) impl.emit('Ticked', label);
      await settle();

      assert.deepStrictEqual((await iterator.next()).value, ['d']);
      assert.deepStrictEqual((await iterator.next()).value, ['e']);
      assert.strictEqual(iterator.dropped, 2);
      await iterator.return();
    });
  });
});
