// `variants: 'tree' | 'plain' | 'wrap'` -- how a `v` comes back.
//
// 'wrap' is the one that is new. It exists because 'plain' throws the
// signature away and nothing downstream can put it back: reconstructing it
// from the value is a guess, since `u`, `i` and `d` all arrive as a JS number.
// See BIG_FUTURE_PLANS 2.1.

const { describe, it } = require('node:test');
const assert = require('assert');
const DBusBuffer = require('../lib/dbus-buffer');
const marshall = require('../lib/marshall');
const {
  Variant,
  variantValue,
  variantSignature,
  toPlain
} = require('../lib/values');

const read = (signature, body, options) =>
  new DBusBuffer(marshall(signature, body), 0, options).read(signature);

const readVariant = options => read('v', [['u', 501]], options)[0];

describe('variants option', () => {
  it("defaults to 'plain', which is the value and nothing else", () => {
    assert.strictEqual(readVariant({}), 501);
  });

  it('follows plainValues when it is not given', () => {
    assert.strictEqual(readVariant({ plainValues: true }), 501);
    // Turning the dicts back to pairs takes the variants with it, which is
    // what makes `withClassicTypes` a single decision rather than two.
    const v = readVariant({ plainValues: false });
    assert.ok(Array.isArray(v));
    assert.strictEqual(v[1][0], 501);
  });

  it('wins over plainValues when it is given', () => {
    const v = readVariant({ plainValues: true, variants: 'wrap' });
    assert.ok(v instanceof Variant);
    // The combination the CLI and a service inspecting a{sv} both want: plain
    // dicts, with the types still on the values inside them.
    assert.strictEqual(v.signature, 'u');
    assert.strictEqual(v.value, 501);
  });

  it("'tree' overrides plainValues in the other direction", () => {
    const v = readVariant({ plainValues: true, variants: 'tree' });
    assert.ok(Array.isArray(v));
    assert.strictEqual(v[1][0], 501);
  });

  it('rejects an unknown shape rather than silently picking one', () => {
    assert.throws(
      () => readVariant({ variants: 'plane' }),
      /Unknown 'variants' option "plane"; expected 'tree', 'plain' or 'wrap'/
    );
  });

  it('reports the signature the sender wrote, not one inferred', () => {
    // All three arrive as a JS number, so a shape that re-derived the
    // signature from the value could not tell them apart.
    for (const signature of ['y', 'n', 'q', 'i', 'u', 'd']) {
      const [v] = read('v', [[signature, 7]], { variants: 'wrap' });
      assert.strictEqual(v.signature, signature);
      assert.strictEqual(typeof v.value, 'number');
    }
  });

  it('carries a container signature whole', () => {
    const [v] = read('v', [['a{ss}', [['a', 'b']]]], { variants: 'wrap' });
    assert.strictEqual(v.signature, 'a{ss}');
  });

  describe('the accessors read it', () => {
    const shapes = ['tree', 'plain', 'wrap'];

    it('variantValue() is the value in all three', () => {
      for (const variants of shapes) {
        assert.strictEqual(variantValue(readVariant({ variants })), 501);
      }
    });

    it('variantSignature() is the signature wherever there is one', () => {
      assert.strictEqual(
        variantSignature(readVariant({ variants: 'tree' })),
        'u'
      );
      assert.strictEqual(
        variantSignature(readVariant({ variants: 'wrap' })),
        'u'
      );
      // The one thing 'plain' trades away.
      assert.strictEqual(
        variantSignature(readVariant({ variants: 'plain' })),
        undefined
      );
    });

    it('toPlain() flattens all three the same', () => {
      for (const variants of shapes) {
        const [dict] = read('a{sv}', [{ Name: new Variant('s', 'eth0') }], {
          variants,
          plainValues: true
        });
        assert.deepStrictEqual(toPlain(dict), { Name: 'eth0' });
      }
    });
  });

  it('round-trips: a wrapped value can be sent straight back out', () => {
    // The tree shape never had this property -- you had to unwrap it first.
    // It is most of the argument for Variant being the better carrier.
    const [v] = read('v', [['a{ss}', [['k', 'v']]]], { variants: 'wrap' });
    const [back] = read('v', [v], { variants: 'wrap' });
    assert.strictEqual(back.signature, 'a{ss}');
    assert.deepStrictEqual(toPlain(back), { k: 'v' });
  });
});
