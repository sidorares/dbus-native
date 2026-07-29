// The CLI pins the value shapes it reads, rather than following the defaults.
//
// `describe()` prints a variant as `variant u 501`. That `u` only exists in the
// parsed signature tree, which `plainValues` discards -- so the day 2.0 flips
// that default, a CLI that inherited it would quietly stop printing types.
// These tests are here to fail if the pin is ever removed.

const { describe, it } = require('node:test');
const assert = require('assert');
const DBusBuffer = require('../lib/dbus-buffer');
const marshall = require('../lib/marshall');
const { SHAPE, describe: render } = require('../lib/cli/call');

// A `v` holding a `u`, read back the way the given options would read it.
const readVariant = options => {
  const buffer = marshall('v', [['u', 501]]);
  return new DBusBuffer(buffer, 0, options).read('v')[0];
};

describe('cli value shapes', () => {
  it('asks for the tree shape and for bigints', () => {
    assert.deepStrictEqual(SHAPE, { returnBigInt: true, plainValues: false });
  });

  it('prints a variant with its signature under the pinned shape', () => {
    assert.strictEqual(render(readVariant(SHAPE), 0), 'variant u 501');
  });

  it('cannot print the signature once plainValues has discarded it', () => {
    // Not a wish, a demonstration: this is what the output becomes if the pin
    // goes away. 2.0 needs a way to ask for `Variant` wrappers before the CLI
    // can use the modern shape at all.
    const plain = readVariant({ ...SHAPE, plainValues: true });
    assert.strictEqual(render(plain, 0), '501');
  });

  it('does not round a 64-bit value on the way to the terminal', () => {
    const buffer = marshall('t', [18446744073709551615n]);
    const [value] = new DBusBuffer(buffer, 0, SHAPE).read('t');
    assert.strictEqual(render(value, 0), '18446744073709551615');
  });
});
