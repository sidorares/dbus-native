// Opt-in BigInt for the 64-bit types.
//
// `x` and `t` cover the full signed/unsigned 64-bit range, which a JS `number`
// cannot: everything above 2^53 comes back approximated. These tests use the
// exact boundary values, because that is where the current behaviour is wrong
// and where an off-by-one in the conversion would hide.

const { describe, it } = require('node:test');
const assert = require('assert');
const marshall = require('../lib/marshall');
const unmarshall = require('../lib/unmarshall');
const DBusBuffer = require('../lib/dbus-buffer');
const constants = require('../lib/constants');

const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;
const UINT64_MAX = 18446744073709551615n;

// unmarshall(buffer, signature, startPos, options) -- note the startPos.
const read = (buf, sig, options) => unmarshall(buf, sig, 0, options);
const roundTrip = (sig, value, options) =>
  read(marshall(sig, [value]), sig, options)[0];

describe('BigInt: reading with returnBigInt', () => {
  const big = { returnBigInt: true };

  it('round-trips the signed 64-bit extremes exactly', () => {
    assert.strictEqual(roundTrip('x', INT64_MAX, big), INT64_MAX);
    assert.strictEqual(roundTrip('x', INT64_MIN, big), INT64_MIN);
  });

  it('round-trips the unsigned 64-bit extremes exactly', () => {
    assert.strictEqual(roundTrip('t', UINT64_MAX, big), UINT64_MAX);
    assert.strictEqual(roundTrip('t', 0n, big), 0n);
  });

  it('round-trips small and negative values', () => {
    for (const v of [1n, -1n, 42n, -42n, 4294967296n]) {
      assert.strictEqual(roundTrip('x', v, big), v, `${v}`);
    }
  });

  it('returns a bigint, not a number or a Long', () => {
    assert.strictEqual(typeof roundTrip('t', 7n, big), 'bigint');
  });

  // The reason the option exists.
  it('is exact where a number is not', () => {
    const asNumber = roundTrip('x', INT64_MAX);
    assert.strictEqual(typeof asNumber, 'number');
    assert.notStrictEqual(BigInt(asNumber), INT64_MAX);
    assert.strictEqual(roundTrip('x', INT64_MAX, big), INT64_MAX);
  });

  it('reads big-endian messages too', () => {
    const value = 0x1122334455667788n;
    for (const [endianness, write] of [
      [constants.endianness.le, 'writeBigInt64LE'],
      [constants.endianness.be, 'writeBigInt64BE']
    ]) {
      const buf = Buffer.alloc(8);
      buf[write](value);
      const parser = new DBusBuffer(buf, 0, { returnBigInt: true }, endianness);
      assert.strictEqual(parser.readSimpleType('x'), value, write);
    }
  });

  it('reads an unsigned value above the signed maximum', () => {
    // The bit pattern is negative when read as signed; the unsigned accessor
    // is what makes `t` come back right.
    assert.strictEqual(roundTrip('t', UINT64_MAX, big), UINT64_MAX);
    assert.strictEqual(roundTrip('x', -1n, big), -1n);
  });

  it('handles 64-bit values inside a container', () => {
    const buf = marshall('a(xt)', [[[INT64_MIN, UINT64_MAX]]]);
    assert.deepStrictEqual(read(buf, 'a(xt)', big)[0], [
      [INT64_MIN, UINT64_MAX]
    ]);
  });
});

describe('BigInt: the default is unchanged', () => {
  it('still returns a number when the option is absent', () => {
    assert.strictEqual(typeof roundTrip('x', 42n), 'number');
    assert.strictEqual(roundTrip('x', 42n), 42);
  });

  it('still returns a Long with ReturnLongjs', () => {
    const v = roundTrip('x', 42n, { ReturnLongjs: true });
    assert.strictEqual(typeof v, 'object');
    assert.strictEqual(v.toString(), '42');
  });

  it('prefers BigInt when both options are set', () => {
    // returnBigInt is the shape these become in 2.0. Someone who sets both is
    // migrating, and should get the destination rather than the deprecation.
    assert.strictEqual(
      roundTrip('x', 42n, { returnBigInt: true, ReturnLongjs: true }),
      42n
    );
  });
});

describe('BigInt: writing', () => {
  // Accepting bigint on write is not gated on the read option, so a call site
  // can be migrated on its own rather than in a flag day.
  it('accepts a bigint without returnBigInt', () => {
    assert.strictEqual(roundTrip('x', 123n), 123);
  });

  it('accepts the 64-bit extremes', () => {
    for (const [sig, v] of [
      ['x', INT64_MAX],
      ['x', INT64_MIN],
      ['t', UINT64_MAX]
    ]) {
      assert.strictEqual(
        roundTrip(sig, v, { returnBigInt: true }),
        v,
        `${sig} ${v}`
      );
    }
  });

  it('rejects a bigint past the signed range', () => {
    assert.throws(() => marshall('x', [INT64_MAX + 1n]), /out of range/);
    assert.throws(() => marshall('x', [INT64_MIN - 1n]), /out of range/);
  });

  it('rejects a bigint past the unsigned range', () => {
    assert.throws(() => marshall('t', [UINT64_MAX + 1n]), /out of range/);
    assert.throws(() => marshall('t', [-1n]), /out of range/);
  });

  it('still accepts numbers, strings and hex strings', () => {
    const big = { returnBigInt: true };
    assert.strictEqual(roundTrip('x', 42, big), 42n);
    assert.strictEqual(roundTrip('t', '18446744073709551615', big), UINT64_MAX);
    assert.strictEqual(roundTrip('x', '-0x8000000000000000', big), INT64_MIN);
  });

  it('marshalls a bigint and a string to identical bytes', () => {
    assert.deepStrictEqual(
      marshall('t', [UINT64_MAX]),
      marshall('t', ['18446744073709551615'])
    );
  });
});

describe('BigInt: diagnostics survive a bigint body', () => {
  // These messages are built with JSON.stringify, which throws on a BigInt.
  // Without care the diagnostic replaces the error it was describing: a body
  // that did not match its signature reported "Do not know how to serialize a
  // BigInt" instead, which says nothing about the actual problem.
  it('reports a signature mismatch, not a serialisation failure', () => {
    assert.throws(
      () => marshall('xt', [[1n, 2n]]),
      err => {
        assert.match(err.message, /does not match message signature/);
        assert.doesNotMatch(err.message, /serialize a BigInt/);
        return true;
      }
    );
  });

  it('reports a wrong type for a string field', () => {
    assert.throws(
      () => marshall('s', [42n]),
      err => {
        assert.match(err.message, /Expected string or buffer/);
        assert.match(err.message, /42n/, 'renders the value it rejected');
        return true;
      }
    );
  });

  it('reports a non-array where an array was expected', () => {
    assert.throws(
      () => marshall('as', [1n]),
      err => {
        assert.match(err.message, /Expected an array/);
        assert.doesNotMatch(err.message, /serialize a BigInt/);
        return true;
      }
    );
  });
});
