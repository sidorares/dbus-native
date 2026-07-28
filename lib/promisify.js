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
function maybePromise(callback, run) {
  if (typeof callback === 'function') return run(callback);

  let outcome = null; // { err } | { value } once the call has completed
  let settle = null; // set once someone is actually waiting

  const value = values => {
    if (values.length === 0) return undefined;
    return values.length === 1 ? values[0] : values;
  };

  run(function (err, ...values) {
    if (settle)
      return err
        ? settle.reject(toDBusError(err))
        : settle.resolve(value(values));
    outcome = err ? { err } : { value: value(values) };
  });

  let promise = null;
  const materialise = () => {
    if (promise) return promise;
    promise = new Promise((resolve, reject) => {
      if (outcome) {
        return outcome.err
          ? reject(toDBusError(outcome.err))
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
