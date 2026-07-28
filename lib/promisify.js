const { toDBusError } = require('./errors');

/**
 * Run a callback-style operation, returning a thenable when the caller did not
 * supply a callback.
 *
 * The callback path is untouched: same arguments, same timing. Only the
 * no-callback case is new, so adding this to an existing method is additive.
 *
 * Resolution follows the number of values in the reply body, because most
 * D-Bus methods return zero or one:
 *
 *   0 values  -> undefined
 *   1 value   -> the value
 *   2 or more -> an array of values
 *
 * Rejection is always a `DBusError`, even though the callback path still
 * receives the raw body array until 1.0.
 *
 * ## Why a thenable rather than a Promise
 *
 * Calling without a callback has always meant fire-and-forget -- this repo's
 * own examples do `bus.invoke({ member: 'AddMatch', ... })` and ignore the
 * result. A failure there used to be silently dropped. If we returned a real
 * Promise, that same code would now produce an unhandled rejection and, on
 * Node 15+, terminate the process: a breaking change smuggled into a minor.
 *
 * So the underlying Promise is constructed lazily, on first `then`/`catch`/
 * `finally`. Await it and you get full promise semantics; ignore it and
 * nothing is ever constructed, so there is nothing to go unhandled and the
 * behaviour is exactly what it was before.
 *
 * The operation itself always runs immediately -- laziness applies only to
 * observing the outcome.
 */
/**
 * Append the frames captured where the call was made.
 *
 * A reply arrives on the socket, so the error is constructed inside the read
 * handler and its own stack points at this library. Without this, a rejected
 * call tells you nothing about which of your call sites produced it.
 */
function withCallSite(err, callSite) {
  if (!callSite.stack) return err;
  const frames = callSite.stack.split('\n').slice(1).join('\n');
  if (frames)
    err.stack = `${err.stack}\n    --- d-bus call made at ---\n${frames}`;
  return err;
}

function maybePromise(callback, run) {
  if (typeof callback === 'function') return run(callback);

  // Captured synchronously, before the call goes async. Only the promise path
  // pays for this; the callback path returned above.
  const callSite = {};
  Error.captureStackTrace(callSite, maybePromise);

  let outcome = null; // { err } | { value } once the call has completed
  let settle = null; // set once someone is actually waiting

  const value = values => {
    if (values.length === 0) return undefined;
    return values.length === 1 ? values[0] : values;
  };

  run((err, ...values) => {
    if (settle)
      return err
        ? settle.reject(withCallSite(toDBusError(err), callSite))
        : settle.resolve(value(values));
    outcome = err ? { err } : { value: value(values) };
  });

  let promise = null;
  const materialise = () => {
    if (promise) return promise;
    promise = new Promise((resolve, reject) => {
      if (outcome) {
        return outcome.err
          ? reject(withCallSite(toDBusError(outcome.err), callSite))
          : resolve(outcome.value);
      }
      settle = { resolve, reject };
    });
    return promise;
  };

  return {
    then: (onFulfilled, onRejected) =>
      materialise().then(onFulfilled, onRejected),
    catch: onRejected => materialise().catch(onRejected),
    finally: onFinally => materialise().finally(onFinally),
    get [Symbol.toStringTag]() {
      return 'Promise';
    }
  };
}

module.exports = { maybePromise };
