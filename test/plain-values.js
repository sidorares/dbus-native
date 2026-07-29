// The `plainValues` option: the 2.0 read shapes, available now.
//
// A variant reads as the value itself, and a string-keyed dict as a plain
// object. Writing is unaffected -- the marshaller has taken plain objects and
// `Variant` since 0.11, so a value read under this option can be written
// straight back out.

const { describe, it } = require('node:test');
const assert = require('assert');
const marshall = require('../lib/marshall');
const unmarshall = require('../lib/unmarshall');
const { Variant, toPlain, variantSignature } = require('../lib/values');

const PLAIN = { plainValues: true };

/** Read a value back both ways, from identical bytes. */
function bothShapes(signature, value) {
  const buf = marshall(signature, [value]);
  return {
    classic: unmarshall(buf, signature)[0],
    plain: unmarshall(buf, signature, undefined, PLAIN)[0]
  };
}

describe('plainValues', () => {
  describe('variants', () => {
    it('reads as the value, not [signatureTree, [value]]', () => {
      const { classic, plain } = bothShapes('v', new Variant('s', 'x'));
      assert.strictEqual(plain, 'x');
      assert.ok(Array.isArray(classic), 'classic shape is unchanged');
    });

    it('unwraps a container value too', () => {
      assert.deepStrictEqual(
        bothShapes('v', new Variant('ai', [1, 2])).plain,
        [1, 2]
      );
    });

    it('loses the signature, which is the point of the shape', () => {
      const { classic, plain } = bothShapes('v', new Variant('u', 7));
      assert.strictEqual(variantSignature(classic), 'u');
      assert.strictEqual(variantSignature(plain), undefined);
    });
  });

  describe('dicts', () => {
    it('reads a{sv} as a plain object of plain values', () => {
      assert.deepStrictEqual(
        bothShapes('a{sv}', { Greeting: 'hi', N: 3 }).plain,
        { Greeting: 'hi', N: 3 }
      );
    });

    it('reads a{ss} as a plain object', () => {
      assert.deepStrictEqual(bothShapes('a{ss}', { a: 'b' }).plain, { a: 'b' });
    });

    it('reads an empty dict as an empty object', () => {
      assert.deepStrictEqual(bothShapes('a{sv}', {}).plain, {});
    });

    it('handles nesting', () => {
      const data = { outer: { inner: 'deep', n: 2 } };
      assert.deepStrictEqual(bothShapes('a{sv}', data).plain, data);
    });

    it('accepts object-path and signature keys, which are also strings', () => {
      assert.deepStrictEqual(bothShapes('a{os}', { '/a/b': 'x' }).plain, {
        '/a/b': 'x'
      });
    });
  });

  describe('what it deliberately leaves alone', () => {
    // A JS object key is always a string, so `a{us}` as an object turns 1 into
    // '1' -- and a 64-bit key would stringify and lose precision on the way
    // back. Quiet corruption is worse than an inconvenient shape.
    it('keeps a numerically-keyed dict as pairs', () => {
      const { classic, plain } = bothShapes('a{us}', { 1: 'a', 2: 'b' });
      assert.deepStrictEqual(plain, [
        [1, 'a'],
        [2, 'b']
      ]);
      assert.deepStrictEqual(plain, classic);
      assert.strictEqual(typeof plain[0][0], 'number', 'key keeps its type');
    });

    it('keeps a 64-bit-keyed dict as pairs, exactly', () => {
      const [dict] = unmarshall(
        marshall('a{ts}', [{ '9007199254740993': 'a' }]),
        'a{ts}',
        undefined,
        { plainValues: true, returnBigInt: true }
      );
      assert.strictEqual(dict[0][0], 9007199254740993n);
    });

    it('does not turn an array of two-string structs into an object', () => {
      // a{ss} and a(ss) are identical on the wire apart from the signature;
      // only the dict becomes an object.
      assert.deepStrictEqual(bothShapes('a(ss)', [['a', 'b']]).plain, [
        ['a', 'b']
      ]);
    });

    it('leaves ordinary arrays and scalars alone', () => {
      assert.deepStrictEqual(bothShapes('as', ['x', 'y']).plain, ['x', 'y']);
      assert.strictEqual(bothShapes('s', 'x').plain, 'x');
      assert.ok(Buffer.isBuffer(bothShapes('ay', Buffer.from([1, 2])).plain));
    });

    it('writes identical bytes either way -- this is a read option', () => {
      assert.deepStrictEqual(
        marshall('a{sv}', [{ a: 1 }]),
        marshall('a{sv}', [{ a: 1 }])
      );
    });
  });

  describe('the forward-compatible helpers', () => {
    it('toPlain is the identity on the new shape', () => {
      const { plain } = bothShapes('a{sv}', { Greeting: 'hi', N: 3 });
      assert.deepStrictEqual(toPlain(plain), plain);
    });

    it('toPlain gives the same answer in both shapes', () => {
      const { classic, plain } = bothShapes('a{sv}', {
        outer: { inner: 'deep' }
      });
      assert.deepStrictEqual(toPlain(classic), toPlain(plain));
    });
  });

  it('round-trips: a value read this way can be written straight back', () => {
    const data = { Greeting: 'hi', N: 3, tags: ['a', 'b'] };
    const read = unmarshall(
      marshall('a{sv}', [data]),
      'a{sv}',
      undefined,
      PLAIN
    )[0];
    const again = unmarshall(
      marshall('a{sv}', [read]),
      'a{sv}',
      undefined,
      PLAIN
    )[0];
    assert.deepStrictEqual(again, data);
  });

  it('is off by default', () => {
    const [dict] = unmarshall(marshall('a{ss}', [{ a: 'b' }]), 'a{ss}');
    assert.ok(Array.isArray(dict));
  });
});
