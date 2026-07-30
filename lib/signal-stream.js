// Signals as an async iterable, with a bound on what it will hold.
//
// An async iterator is a queue and a signal is a broadcast. If the consumer is
// slower than the bus, something has to give, and the only genuinely wrong
// answer is to buffer without limit -- a long-lived daemon with an unbounded
// signal queue is a memory leak with a countdown, and this library's users skew
// toward long-lived daemons. So there is no unbounded option: `queue` is a
// positive integer or the literal 'latest'.
//
// The callback form is the primary API and this is the convenience, which is
// the opposite of how the first draft of BIG_FUTURE_PLANS put it. Async
// iterator helpers are still not in Node (checked on 26), so `.map()`,
// `.filter()` and `.take()` do not exist on these streams -- which removes most
// of what made iteration attractive over a callback. See BIG_FUTURE_PLANS 2.4.

const DEFAULT_QUEUE = 64;

function normaliseQueue(queue) {
  if (queue === undefined) return DEFAULT_QUEUE;
  if (queue === 'latest') return 1;
  if (Number.isInteger(queue) && queue > 0) return queue;
  throw new TypeError(
    `queue must be a positive integer or 'latest', got ${JSON.stringify(queue)}`
  );
}

/**
 * An async iterable over one signal.
 *
 * `subscribe(handler)` is called on the first `next()` and must resolve to
 * something with a `remove()`. It is removed again when the loop ends, however
 * it ends: `break`, `throw`, `return`, or the abort signal firing. That is the
 * point of the shape -- the subscription is released by the language rather
 * than by remembering to.
 *
 * @param {(handler: Function) => Promise<{remove: Function}>} subscribe
 * @param {{queue?: number|'latest', signal?: AbortSignal}} [options]
 */
function signalStream(subscribe, options = {}) {
  const limit = normaliseQueue(options.queue);
  const abort = options.signal;

  return {
    [Symbol.asyncIterator]() {
      /** Delivered but not yet consumed. */
      const pending = [];
      /** How many were dropped because the consumer fell behind. */
      let dropped = 0;
      /** Resolves the `next()` that is currently waiting, if any. */
      let waiting = null;
      let subscription = null;
      let started = false;
      let done = false;

      const push = value => {
        if (done) return;
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve({ value, done: false });
          return;
        }
        pending.push(value);
        // Drop the oldest rather than the newest: a consumer catching up wants
        // the current state, not the state it already missed. Counted rather
        // than silent -- `stream.dropped` is how anyone finds out.
        while (pending.length > limit) {
          pending.shift();
          dropped++;
        }
      };

      const finish = () => {
        if (done) return Promise.resolve();
        done = true;
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve({ value: undefined, done: true });
        }
        if (abort) abort.removeEventListener('abort', onAbort);
        const sub = subscription;
        subscription = null;
        return sub
          ? Promise.resolve(sub.remove()).catch(() => {})
          : Promise.resolve();
      };

      function onAbort() {
        finish();
      }

      const iterator = {
        get dropped() {
          return dropped;
        },

        async next() {
          if (!started) {
            started = true;
            // Aborted before we began: subscribe to nothing.
            if (abort && abort.aborted) {
              done = true;
              return { value: undefined, done: true };
            }
            try {
              subscription = await subscribe(push);
            } catch (err) {
              done = true;
              throw err;
            }
            // The abort may have fired while AddMatch was in flight.
            if (abort) {
              if (abort.aborted) {
                await finish();
                return { value: undefined, done: true };
              }
              abort.addEventListener('abort', onAbort, { once: true });
            }
          }
          if (pending.length) return { value: pending.shift(), done: false };
          if (done) return { value: undefined, done: true };
          return new Promise(resolve => {
            waiting = resolve;
          });
        },

        // Called by `break`, an early `return`, or leaving the loop any other
        // way. This is what makes the subscription lexically scoped.
        async return(value) {
          await finish();
          return { value, done: true };
        },

        async throw(err) {
          await finish();
          throw err;
        },

        [Symbol.asyncIterator]() {
          return iterator;
        }
      };

      return iterator;
    }
  };
}

module.exports = { signalStream, normaliseQueue, DEFAULT_QUEUE };
