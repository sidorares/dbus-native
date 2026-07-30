// The queue policy behind proxy.$signal(), tested without a bus.
//
// An async iterator is a queue and a signal is a broadcast, so the interesting
// behaviour is all at the seam where the consumer is slower than the producer.
// None of that needs a daemon.

const { describe, it } = require('node:test');
const assert = require('assert');
const {
  signalStream,
  normaliseQueue,
  DEFAULT_QUEUE
} = require('../lib/signal-stream');

/** A subscribe() that hands back the emitter, and records removal. */
function fakeSource() {
  const state = { emit: null, removed: 0, subscribed: 0 };
  const subscribe = async handler => {
    state.subscribed++;
    state.emit = handler;
    return {
      remove() {
        state.removed++;
        state.emit = null;
      }
    };
  };
  return { state, subscribe };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('signal stream: the queue bound', () => {
  it("accepts a positive integer or 'latest', and nothing else", () => {
    assert.strictEqual(normaliseQueue(undefined), DEFAULT_QUEUE);
    assert.strictEqual(normaliseQueue(1), 1);
    assert.strictEqual(normaliseQueue(500), 500);
    assert.strictEqual(normaliseQueue('latest'), 1);

    // There is deliberately no unbounded option: an unbounded signal queue in
    // a long-lived daemon is a memory leak with a countdown.
    for (const bad of [0, -1, 1.5, Infinity, null, 'all', 'unbounded', {}]) {
      assert.throws(
        () => normaliseQueue(bad),
        /queue must be a positive integer or 'latest'/,
        JSON.stringify(bad)
      );
    }
  });

  it('drops the oldest when the consumer falls behind, and counts it', async () => {
    const { state, subscribe } = fakeSource();
    const stream = signalStream(subscribe, { queue: 2 });
    const it = stream[Symbol.asyncIterator]();

    // Start the subscription, then let four arrive with nobody waiting.
    const first = it.next();
    await tick();
    state.emit(['a']);
    assert.deepStrictEqual((await first).value, ['a']);

    state.emit(['b']);
    state.emit(['c']);
    state.emit(['d']);
    state.emit(['e']);

    // A consumer catching up wants the current state, not what it missed.
    assert.deepStrictEqual((await it.next()).value, ['d']);
    assert.deepStrictEqual((await it.next()).value, ['e']);
    assert.strictEqual(it.dropped, 2, 'and it says how many went');
    await it.return();
  });

  it("'latest' keeps exactly one", async () => {
    const { state, subscribe } = fakeSource();
    const it = signalStream(subscribe, { queue: 'latest' })[
      Symbol.asyncIterator
    ]();
    const first = it.next();
    await tick();
    state.emit([1]);
    await first;

    state.emit([2]);
    state.emit([3]);
    state.emit([4]);
    assert.deepStrictEqual((await it.next()).value, [4]);
    assert.strictEqual(it.dropped, 2);
    await it.return();
  });

  it('delivers straight through to a waiting consumer', async () => {
    const { state, subscribe } = fakeSource();
    const it = signalStream(subscribe)[Symbol.asyncIterator]();
    const pending = it.next();
    await tick();
    state.emit(['immediate']);
    assert.deepStrictEqual((await pending).value, ['immediate']);
    assert.strictEqual(it.dropped, 0);
    await it.return();
  });
});

describe('signal stream: lifetime', () => {
  it('subscribes once, on the first next()', async () => {
    const { state, subscribe } = fakeSource();
    const it = signalStream(subscribe)[Symbol.asyncIterator]();
    assert.strictEqual(state.subscribed, 0, 'not until asked');

    const first = it.next();
    await tick();
    assert.strictEqual(state.subscribed, 1);
    state.emit([1]);
    await first;
    state.emit([2]);
    await it.next();
    assert.strictEqual(state.subscribed, 1, 'and only once');
    await it.return();
  });

  it('unsubscribes when the loop breaks', async () => {
    const { state, subscribe } = fakeSource();
    const stream = signalStream(subscribe);

    const seen = [];
    const loop = (async () => {
      for await (const value of stream) {
        seen.push(value);
        if (value[0] === 'stop') break;
      }
    })();

    await tick();
    state.emit(['go']);
    await tick();
    state.emit(['stop']);
    await loop;

    assert.deepStrictEqual(seen, [['go'], ['stop']]);
    assert.strictEqual(state.removed, 1, 'break released the subscription');
  });

  it('unsubscribes when the loop throws', async () => {
    const { state, subscribe } = fakeSource();
    const stream = signalStream(subscribe);

    const loop = (async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const value of stream) {
        throw new Error('from inside the loop');
      }
    })();

    await tick();
    state.emit([1]);
    await assert.rejects(loop, /from inside the loop/);
    assert.strictEqual(state.removed, 1);
  });

  it('surfaces a failed subscribe on the first next()', async () => {
    const stream = signalStream(async () => {
      throw new Error('AddMatch refused');
    });
    await assert.rejects(
      (async () => {
        for await (const _ of stream) void _;
      })(),
      /AddMatch refused/
    );
  });

  it('is idempotent about finishing', async () => {
    const { state, subscribe } = fakeSource();
    const it = signalStream(subscribe)[Symbol.asyncIterator]();
    const first = it.next();
    await tick();
    state.emit([1]);
    await first;
    await it.return();
    await it.return();
    assert.strictEqual(state.removed, 1);
    assert.deepStrictEqual(await it.next(), { value: undefined, done: true });
  });
});

describe('signal stream: AbortSignal', () => {
  it('ends the loop and unsubscribes', async () => {
    const { state, subscribe } = fakeSource();
    const ac = new AbortController();
    const stream = signalStream(subscribe, { signal: ac.signal });

    const seen = [];
    const loop = (async () => {
      for await (const value of stream) seen.push(value);
    })();

    await tick();
    state.emit(['before']);
    await tick();
    ac.abort();
    await loop;

    assert.deepStrictEqual(seen, [['before']]);
    assert.strictEqual(state.removed, 1);
  });

  it('never subscribes if it was already aborted', async () => {
    const { state, subscribe } = fakeSource();
    const stream = signalStream(subscribe, { signal: AbortSignal.abort() });
    const seen = [];
    for await (const value of stream) seen.push(value);
    assert.deepStrictEqual(seen, []);
    assert.strictEqual(state.subscribed, 0, 'no AddMatch for a dead loop');
  });

  it('cleans up when it fires while AddMatch is in flight', async () => {
    // The window that is easy to miss: abort between subscribe() being called
    // and its promise settling, which would otherwise leave the rule in place
    // with nothing consuming it.
    const state = { removed: 0 };
    const ac = new AbortController();
    const stream = signalStream(
      async () => {
        ac.abort();
        return {
          remove() {
            state.removed++;
          }
        };
      },
      { signal: ac.signal }
    );

    const seen = [];
    for await (const value of stream) seen.push(value);
    assert.deepStrictEqual(seen, []);
    assert.strictEqual(state.removed, 1, 'the rule was taken back off');
  });
});
