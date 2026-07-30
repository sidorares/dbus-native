// Lets the integration suite be run under every value shape, so a change to
// the defaults is rehearsed rather than discovered after release.
//
// `DBUS_TEST_SHAPE` selects the run:
//
//   plain       the defaults: a variant is the value, a dict is a plain
//               object, and 64-bit is a bigint (the default when unset)
//   wrap        the same, but a variant is a Variant -- the shape a caller
//               opts into when it needs the type back (BIG_FUTURE_PLANS 2.1)
//   classic     what 1.x handed back: a variant is [tree, [value]], a dict is
//               pairs, and 64-bit is a lossy number. This is what
//               `dbus-native/compat` configures, so it has to keep working.
//
// Everything in test/integration should pass in all three, because that is
// exactly the promise the accessors make to users: code written against
// `variantValue()` and `toPlain()` does not care which shape it is looking at.
//
// A test that reads a raw shape directly is a test *about* the shape. Those ask
// which world they are in with VARIANTS / RETURN_BIGINT rather than pretending
// to be agnostic.

const dbus = require('../../index');

const SHAPE = process.env.DBUS_TEST_SHAPE || 'plain';

const KNOWN = new Set(['plain', 'wrap', 'classic']);
if (!KNOWN.has(SHAPE)) {
  throw new Error(
    `Unknown DBUS_TEST_SHAPE ${JSON.stringify(SHAPE)}; expected ${[...KNOWN].join(', ')}`
  );
}

const CLASSIC = SHAPE === 'classic';

/** How a variant reads in this run: 'tree', 'plain' or 'wrap'. */
const VARIANTS = CLASSIC ? 'tree' : SHAPE;

/** True when a string-keyed dict reads as a plain object. */
const PLAIN_VALUES = !CLASSIC;

/** True when `x` and `t` read as `bigint` rather than a lossy `number`. */
const RETURN_BIGINT = !CLASSIC;

const DEFAULTS = CLASSIC
  ? { plainValues: false, returnBigInt: false }
  : // Only stated for the wrap run. Leaving it unset in the 'plain' run is the
    // point: `variants` has to keep defaulting to what `plainValues` implies.
    SHAPE === 'wrap'
    ? { variants: 'wrap' }
    : {};

/**
 * A session bus with the shape this run asked for.
 *
 * Caller options are layered *over* the defaults, not under them, because that
 * is what changing a default means: a test that states a shape explicitly --
 * `{ returnBigInt: false }` -- gets it in every run, and keeps testing the
 * thing it was written to test.
 */
function sessionBus(opts) {
  return dbus.sessionBus({ ...DEFAULTS, ...opts });
}

module.exports = {
  sessionBus,
  SHAPE,
  VARIANTS,
  PLAIN_VALUES,
  RETURN_BIGINT,
  CLASSIC
};
