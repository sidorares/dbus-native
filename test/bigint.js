// BigInt for the 64-bit types -- the default since 2.0.
//
// `x` and `t` cover the full signed/unsigned 64-bit range, which a JS `number`
// cannot: everything above 2^53 used to come back approximated. These tests
// use the exact boundary values, because that is where the old behaviour was
// wrong and where an off-by-one in the conversion would hide.

const { describe, it } = require('node:test');
const assert = require('assert');
const { PassThrough } = require('stream');
const dbus = require('../index');
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

describe('BigInt: reading', () => {
  // Left as an explicit option rather than dropped now that it is the default,
  // so these keep asserting the shape they are named for even if the default
  // moves again.
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

  it('is the default', () => {
    assert.strictEqual(roundTrip('x', INT64_MAX), INT64_MAX);
    assert.strictEqual(typeof roundTrip('t', 7n), 'bigint');
  });

  // The reason it became the default.
  it('is exact where a number is not', () => {
    const asNumber = roundTrip('x', INT64_MAX, { returnBigInt: false });
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

describe('BigInt: opting back out', () => {
  it('returns the lossy number again with returnBigInt: false', () => {
    const v = roundTrip('x', 42n, { returnBigInt: false });
    assert.strictEqual(typeof v, 'number');
    assert.strictEqual(v, 42);
  });

  it('refuses ReturnLongjs rather than quietly handing back a bigint', () => {
    // Someone still passing this expects a Long. Ignoring it would surface as
    // `value.toNumber is not a function`, somewhere else entirely, at whatever
    // point the value is first used.
    assert.throws(
      () =>
        dbus.createConnection({
          stream: new PassThrough(),
          ReturnLongjs: true
        }),
      {
        name: 'TypeError',
        message: /'ReturnLongjs' option was removed.*returnBigInt: false/s
      }
    );
  });

  it('accepts ReturnLongjs: false, which asked for what it now gets', () => {
    const conn = dbus.createConnection({
      stream: new PassThrough(),
      ReturnLongjs: false
    });
    assert.ok(conn);
    conn.end();
  });
});

describe('BigInt: writing', () => {
  // Accepting bigint on write was never gated on the read option, so a call
  // site could be migrated on its own rather than in a flag day.
  it('accepts a bigint whatever the read shape', () => {
    assert.strictEqual(roundTrip('x', 123n), 123n);
    assert.strictEqual(roundTrip('x', 123n, { returnBigInt: false }), 123);
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

// The 64-bit paths have used `bigint` internally since 0.11, and Long.js
// stopped being a dependency in 2.0. A Long is still *accepted* on input --
// the check is structural, on {low, high, unsigned}, so it costs nothing --
// which is what these cover. `long` is a devDependency now, only so the tests
// can build the objects they are asserting about.
describe('64-bit values without Long.js', () => {
  const Long = require('long');

  describe('Long.js is still accepted on write', () => {
    const cases = [
      [
        'signed max',
        'x',
        Long.fromString('9223372036854775807', false),
        INT64_MAX
      ],
      [
        'signed min',
        'x',
        Long.fromString('-9223372036854775808', false),
        INT64_MIN
      ],
      [
        'unsigned max',
        't',
        Long.fromString('18446744073709551615', true),
        UINT64_MAX
      ],
      ['unsigned zero', 't', Long.fromString('0', true), 0n]
    ];

    for (const [what, sig, long, equivalent] of cases) {
      it(`writes the same bytes for a Long and a bigint: ${what}`, () => {
        assert.deepStrictEqual(
          marshall(sig, [long]),
          marshall(sig, [equivalent])
        );
      });
    }

    it('accepts a plain object carrying the Long shape', () => {
      // { low, high, unsigned } is recognised structurally, so accepting it
      // costs no dependency.
      assert.deepStrictEqual(
        marshall('x', [{ low: -1, high: 2147483647, unsigned: false }]),
        marshall('x', [INT64_MAX])
      );
    });

    it('still insists the signedness matches the field', () => {
      assert.throws(
        () => marshall('x', [Long.fromString('1', true)]),
        /Longjs object is unsigned, but marshalling into signed 64 bit field/
      );
      assert.throws(
        () => marshall('t', [Long.fromString('1', false)]),
        /Longjs object is signed, but marshalling into unsigned 64 bit field/
      );
    });
  });

  it('is not required to read one back', () => {
    // The read path has no Long in it at all now: what a Long wrote comes
    // back as the bigint it always represented.
    const [value] = read(
      marshall('x', [Long.fromString('9223372036854775807', false)]),
      'x'
    );
    assert.strictEqual(value, INT64_MAX);
  });

  describe('garbage is refused rather than written as zero', () => {
    // Long.fromBits(undefined, undefined, undefined) produced ZERO, so these
    // used to marshal to eight zero bytes with no complaint at all.
    for (const value of [{}, [], true]) {
      it(`rejects ${JSON.stringify(value) ?? String(value)}`, () => {
        assert.throws(
          () => marshall('x', [value]),
          /Error converting object to 64bit integer/
        );
      });
    }

    it('names what it was given', () => {
      assert.throws(() => marshall('x', [true]), /integer 'boolean'/);
      assert.throws(() => marshall('x', [[]]), /integer 'array'/);
    });
  });

  describe('string forms', () => {
    const same = (sig, a, b) =>
      assert.deepStrictEqual(marshall(sig, [a]), marshall(sig, [b]));

    it('decimal', () => same('x', '9007199254740993', 9007199254740993n));
    it('negative decimal', () => same('x', '-42', -42n));
    it('hex', () => same('x', '0x1FFFFFFFFFFFFF', 0x1fffffffffffffn));
    it('lowercase hex', () => same('x', '0x1fffffffffffff', 0x1fffffffffffffn));
    it('negative hex', () =>
      same('x', '-0x1FFFFFFFFFFFFF', -0x1fffffffffffffn));
    it('leading zeros', () => same('x', '000042', 42n));
    it('surrounding space', () => same('x', '  42  ', 42n));

    it('reports a string that does not fit the field', () => {
      assert.throws(
        () => marshall('x', ['18446744073709551615']),
        /did not convert correctly to signed 64 bit/
      );
      assert.throws(
        () => marshall('t', ['-42']),
        /did not convert correctly to unsigned 64 bit/
      );
    });

    it('reports an unparseable string', () => {
      assert.throws(
        () => marshall('x', ['not a number']),
        /did not convert correctly/
      );
      assert.throws(
        () => marshall('x', ['']),
        /Error converting string to 64bit integer 'empty string'/
      );
    });
  });
});
