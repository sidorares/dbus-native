// Writing a plain JavaScript object where a dict is expected.
//
// Since 2.0 the read side returns an object too, so a round trip is an
// identity. `toPlain()` stays in the helper below because it is the identity
// on the current shape and still flattens the old one, which is what makes
// these assertions readable either way. The skipped test this file replaces
// asserted a plain object came *back*, which is why it could never have
// passed: it was waiting on the read half too.

const { describe, it } = require('node:test');
const assert = require('assert');
const marshall = require('../lib/marshall');
const unmarshall = require('../lib/unmarshall');
const { Variant, toPlain, variantSignature } = require('../lib/values');

/** marshall, unmarshall, and flatten to plain JS. */
function roundTrip(signature, data) {
  return toPlain(unmarshall(marshall(signature, data), signature));
}

/**
 * The signature a single inferred value actually got on the wire.
 *
 * Read under `variants: 'wrap'`, which is what that shape is for: the default
 * flattens a variant to its value and the signature -- the thing being
 * asserted here -- is gone.
 */
function inferred(value) {
  const [dict] = unmarshall(
    marshall('a{sv}', [{ v: value }]),
    'a{sv}',
    undefined,
    {
      variants: 'wrap'
    }
  );
  return variantSignature(dict.v);
}

describe('a plain object as a dict', () => {
  it('round-trips a nested object, the case the old skipped test described', () => {
    const data = {
      test1: { subobj: { a1: 10, a2: 'qqq', a3: 1.11 }, test2: 12 }
    };
    assert.deepStrictEqual(roundTrip('a{sv}', [data]), [data]);
  });

  it('writes the same bytes as the equivalent array of pairs', () => {
    const asObject = marshall('a{sv}', [{ Greeting: 'hello', Count: 3 }]);
    const asPairs = marshall('a{sv}', [
      [
        ['Greeting', new Variant('s', 'hello')],
        ['Count', new Variant('i', 3)]
      ]
    ]);
    assert.deepStrictEqual(asObject, asPairs);
  });

  it('accepts an empty object', () => {
    assert.deepStrictEqual(roundTrip('a{sv}', [{}]), [{}]);
  });

  it('still accepts the array-of-pairs form unchanged', () => {
    const pairs = [[['Greeting', new Variant('s', 'hello')]]];
    assert.deepStrictEqual(roundTrip('a{sv}', pairs), [{ Greeting: 'hello' }]);
  });

  it('works for a dict whose values are not variants', () => {
    assert.deepStrictEqual(roundTrip('a{ss}', [{ a: 'x', b: 'y' }]), [
      { a: 'x', b: 'y' }
    ]);
  });

  it('works as one argument among several', () => {
    assert.deepStrictEqual(roundTrip('sa{sv}u', ['name', { a: 1 }, 7]), [
      'name',
      { a: 1 },
      7
    ]);
  });

  it('works nested inside an array of dicts', () => {
    assert.deepStrictEqual(roundTrip('aa{ss}', [[{ a: 'x' }, { b: 'y' }]]), [
      [{ a: 'x' }, { b: 'y' }]
    ]);
  });

  it('converts numeric keys back from the strings JS makes them', () => {
    assert.deepStrictEqual(roundTrip('a{us}', [{ 1: 'a', 2: 'b' }]), [
      { 1: 'a', 2: 'b' }
    ]);
  });

  it('keeps 64-bit keys exact, by leaving them as the strings they are', () => {
    // Note the key is written as a string. A numeric literal this large is
    // already rounded by JavaScript before it ever becomes a key, so
    // { 9007199254740993: 'a' } is a different (smaller) key entirely -- which
    // is why these types are not put through Number().
    const [dict] = unmarshall(
      marshall('a{ts}', [{ '9007199254740993': 'a' }]),
      'a{ts}',
      undefined,
      { returnBigInt: true }
    );
    assert.strictEqual(dict[0][0], 9007199254740993n);
  });

  // The writer wanted a signature string exactly where the reader puts a
  // parsed tree, so handing a value from one service straight to another
  // failed with a complaint about type 'g'.
  it('can write back a dict it just read', () => {
    const read = unmarshall(marshall('a{sv}', [{ a: 'x', n: 5 }]), 'a{sv}')[0];
    assert.deepStrictEqual(roundTrip('a{sv}', [read]), [{ a: 'x', n: 5 }]);
  });

  it('can write back a nested dict it just read', () => {
    const data = { outer: { inner: 'deep', n: 2 } };
    const read = unmarshall(marshall('a{sv}', [data]), 'a{sv}')[0];
    assert.deepStrictEqual(roundTrip('a{sv}', [read]), [data]);
  });

  it('can write back a single variant it just read', () => {
    const read = unmarshall(marshall('v', [new Variant('s', 'x')]), 'v')[0];
    assert.deepStrictEqual(roundTrip('v', [read]), ['x']);
  });

  it('does not treat a class instance as a dict', () => {
    class Config {
      constructor() {
        this.a = 1;
      }
    }
    assert.throws(() => marshall('a{sv}', [new Config()]), {
      message: /Expected an array of \[key, value\] pairs, or a plain object/
    });
  });
});

describe('inferring a signature inside a dict', () => {
  const cases = [
    ['a string', 'hello', 's'],
    ['a boolean', true, 'b'],
    ['an integer', 10, 'i'],
    ['a negative integer', -10, 'i'],
    ['a non-integer', 1.11, 'd'],
    ['an integer beyond int32', 2147483648, 'x'],
    ['an integer below int32', -2147483649, 'x'],
    ['a bigint', 42n, 'x'],
    ['a Buffer', Buffer.from([1, 2]), 'ay'],
    ['an array of strings', ['a', 'b'], 'as'],
    ['an array of integers', [1, 2], 'ai'],
    ['a nested array', [[1], [2]], 'aai'],
    ['a nested object', { a: 1 }, 'a{sv}']
  ];

  for (const [what, value, signature] of cases) {
    it(`infers '${signature}' for ${what}`, () => {
      assert.strictEqual(inferred(value), signature);
    });
  }

  it('lets a Variant override the inferred type', () => {
    assert.strictEqual(inferred(new Variant('u', 10)), 'u');
    assert.strictEqual(inferred(new Variant('d', 10)), 'd');
  });

  it('keeps a Variant nested inside an inferred object', () => {
    const written = unmarshall(
      marshall('a{sv}', [{ outer: { inner: new Variant('u', 7) } }]),
      'a{sv}'
    );
    assert.deepStrictEqual(toPlain(written), [{ outer: { inner: 7 } }]);
  });

  it('treats an array as an array, never as a [signature, value] pair', () => {
    // The one thing to know about the object form: this is 'as', not a
    // classic variant pair meaning the string 'hello' typed as 's'.
    assert.strictEqual(inferred(['s', 'hello']), 'as');
    assert.deepStrictEqual(roundTrip('a{sv}', [{ v: ['s', 'hello'] }]), [
      { v: ['s', 'hello'] }
    ]);
  });

  describe('refuses to guess', () => {
    const rejects = [
      ['an empty array', [], /empty array/],
      ['a mixed array', [1, 'a'], /mixed array/],
      ['null', null, /null value is not supported/],
      ['undefined', undefined, /'undefined' type is not supported/],
      ['NaN', NaN, /no infinity or NaN/],
      ['Infinity', Infinity, /no infinity or NaN/],
      ['a function', () => {}, /type for a function -- wrap it in a Variant/],
      ['a Date', new Date(), /type for a Date \(/],
      ['a Map', new Map(), /type for a Map \(/],
      ['a symbol', Symbol('x'), /type for a symbol --/]
    ];

    for (const [what, value, message] of rejects) {
      it(`rejects ${what}`, () => {
        assert.throws(() => marshall('a{sv}', [{ v: value }]), { message });
      });
    }

    it('names both element types when an array is mixed', () => {
      assert.throws(() => marshall('a{sv}', [{ v: [1, 'a'] }]), {
        message: /element 0 is 'i', element 1 is 's'/
      });
    });
  });
});
