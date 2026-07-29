// Lets the integration suite be run under the 2.0 value shapes, so the flag
// day can be rehearsed on a released version instead of discovered after it.
//
// `DBUS_TEST_SHAPE=2.0` turns on the options that 2.0 makes the default
// (RELEASE_PLAN.md): a variant reads as its value and a string-keyed dict as a
// plain object, and 64-bit integers read as `bigint`. Everything in
// test/integration should pass either way, because that is exactly the promise
// the 0.6 accessors make to users -- code written against `variantValue()` and
// `toPlain()` does not care which shape it is looking at.
//
// A test that reads a raw shape directly is a test *about* the shape. Those ask
// which world they are in with PLAIN_VALUES / RETURN_BIGINT rather than
// pretending to be agnostic.

const dbus = require('../../index');

const TWO_OH = process.env.DBUS_TEST_SHAPE === '2.0';

/** True when a variant reads as its value and an a{sv} as a plain object. */
const PLAIN_VALUES = TWO_OH;

/** True when `x` and `t` read as `bigint` rather than a lossy `number`. */
const RETURN_BIGINT = TWO_OH;

const DEFAULTS = TWO_OH ? { plainValues: true, returnBigInt: true } : {};

/**
 * A session bus with the shape this run asked for.
 *
 * Caller options are layered *over* the defaults, not under them, because that
 * is what changing a default means: a test that states a shape explicitly --
 * `{ returnBigInt: false }` -- gets it in both runs, and keeps testing the
 * thing it was written to test.
 */
function sessionBus(opts) {
  return dbus.sessionBus({ ...DEFAULTS, ...opts });
}

module.exports = { sessionBus, PLAIN_VALUES, RETURN_BIGINT, TWO_OH };
