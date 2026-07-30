// Lets the integration suite be run under the 2.0 value shapes, so the flag
// day can be rehearsed on a released version instead of discovered after it.
//
// `DBUS_TEST_SHAPE` selects the run:
//
//   unset       what 1.x hands back: a variant is [tree, [value]], a dict is
//               pairs, and 64-bit is a lossy number
//   2.0         what 2.0 makes the default: plain values and bigint
//   2.0-wrap    the same, but a variant is a Variant -- the shape a caller
//               opts into when it needs the type back (BIG_FUTURE_PLANS 2.1)
//
// Everything in test/integration should pass in all three, because that is
// exactly the promise the 0.6 accessors make to users: code written against
// `variantValue()` and `toPlain()` does not care which shape it is looking at.
//
// A test that reads a raw shape directly is a test *about* the shape. Those ask
// which world they are in with VARIANTS / RETURN_BIGINT rather than pretending
// to be agnostic.

const dbus = require('../../index');

const SHAPE = process.env.DBUS_TEST_SHAPE || 'classic';

const KNOWN = new Set(['classic', '2.0', '2.0-wrap']);
if (!KNOWN.has(SHAPE)) {
  throw new Error(
    `Unknown DBUS_TEST_SHAPE ${JSON.stringify(SHAPE)}; expected ${[...KNOWN].join(', ')}`
  );
}

const TWO_OH = SHAPE !== 'classic';

/** How a variant reads in this run: 'tree', 'plain' or 'wrap'. */
const VARIANTS =
  SHAPE === '2.0-wrap' ? 'wrap' : SHAPE === '2.0' ? 'plain' : 'tree';

/** True when a string-keyed dict reads as a plain object. */
const PLAIN_VALUES = TWO_OH;

/** True when `x` and `t` read as `bigint` rather than a lossy `number`. */
const RETURN_BIGINT = TWO_OH;

const DEFAULTS = TWO_OH
  ? {
      plainValues: true,
      returnBigInt: true,
      // Only stated for the wrap run. Leaving it unset in the '2.0' run is the
      // point: `variants` has to keep defaulting to what `plainValues` implies,
      // or every existing caller of `plainValues` changes behaviour.
      ...(VARIANTS === 'wrap' ? { variants: 'wrap' } : {})
    }
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
  TWO_OH
};
