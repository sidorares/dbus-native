// Forward-compatible value helpers: the same call must work on today's shapes
// and on the 2.0 shapes, so each case is asserted against both.

const assert = require('assert');
const dbus = require('../index');
const marshall = require('../lib/marshall');
const unmarshall = require('../lib/unmarshall');
const { Variant, variantValue, variantSignature, toPlain } = dbus;

const roundTrip = (signature, body) =>
  unmarshall(marshall(signature, body), signature);

describe('variantValue', () => {
  it('unwraps a variant as it is parsed today', () => {
    const [value] = roundTrip('v', [['s', 'hello']]);
    assert.strictEqual(variantValue(value), 'hello');
  });

  it('is the identity on an already-plain value (the 2.0 shape)', () => {
    assert.strictEqual(variantValue('hello'), 'hello');
    assert.strictEqual(variantValue(42), 42);
    assert.deepStrictEqual(variantValue([1, 2, 3]), [1, 2, 3]);
    assert.deepStrictEqual(variantValue({ a: 1 }), { a: 1 });
  });

  it('unwraps a Variant instance', () => {
    assert.strictEqual(variantValue(new Variant('s', 'hello')), 'hello');
  });

  it('handles container values inside a variant', () => {
    const [value] = roundTrip('v', [['ai', [1, 2, 3]]]);
    assert.deepStrictEqual(variantValue(value), [1, 2, 3]);
  });

  it('does not mistake an ordinary two-element array for a variant', () => {
    assert.deepStrictEqual(variantValue(['a', 'b']), ['a', 'b']);
    assert.deepStrictEqual(variantValue([[1, 2], [3]]), [[1, 2], [3]]);
  });

  it('recognises a hand-built classic variant with no tag', () => {
    const handBuilt = [[{ type: 's', child: [] }], ['hello']];
    assert.strictEqual(variantValue(handBuilt), 'hello');
  });
});

describe('variantSignature', () => {
  it('reports the signature of a parsed variant', () => {
    assert.strictEqual(variantSignature(roundTrip('v', [['s', 'x']])[0]), 's');
    assert.strictEqual(
      variantSignature(roundTrip('v', [['ai', [1]]])[0]),
      'ai'
    );
    assert.strictEqual(
      variantSignature(roundTrip('v', [['a{sv}', [['k', ['s', 'v']]]]])[0]),
      'a{sv}'
    );
  });

  it('reports a Variant instance signature', () => {
    assert.strictEqual(variantSignature(new Variant('u', 1)), 'u');
  });

  it('is undefined once the value has been flattened', () => {
    assert.strictEqual(variantSignature('hello'), undefined);
  });
});

describe('toPlain', () => {
  it('converts a dict of variants to an object', () => {
    const [dict] = roundTrip('a{sv}', [
      [
        ['Udi', ['s', '/sys/devices/pci0000:00/net/wlan0']],
        ['Speed', ['u', 1000]],
        ['Up', ['b', true]]
      ]
    ]);
    assert.deepStrictEqual(toPlain(dict), {
      Udi: '/sys/devices/pci0000:00/net/wlan0',
      Speed: 1000,
      Up: true
    });
  });

  it('converts a dict of plain values', () => {
    const [dict] = roundTrip('a{ss}', [
      [
        ['a', '1'],
        ['b', '2']
      ]
    ]);
    assert.deepStrictEqual(toPlain(dict), { a: '1', b: '2' });
  });

  it('recurses into nested dicts', () => {
    const [dict] = roundTrip('a{sa{ss}}', [[['outer', [['inner', 'value']]]]]);
    assert.deepStrictEqual(toPlain(dict), { outer: { inner: 'value' } });
  });

  // a{ss} and a(ss) are structurally identical once parsed. A shape-based
  // heuristic would convert both; the parser tags dicts so this one does not.
  it('leaves an array of two-string structs alone', () => {
    const [structs] = roundTrip('a(ss)', [
      [
        ['a', '1'],
        ['b', '2']
      ]
    ]);
    assert.deepStrictEqual(toPlain(structs), [
      ['a', '1'],
      ['b', '2']
    ]);
  });

  it('is the identity on the 2.0 shape', () => {
    assert.deepStrictEqual(toPlain({ a: 1, b: 'two' }), { a: 1, b: 'two' });
    assert.deepStrictEqual(toPlain([1, 2, 3]), [1, 2, 3]);
    assert.strictEqual(toPlain('plain'), 'plain');
  });

  it('unwraps variants inside ordinary arrays', () => {
    const [values] = roundTrip('av', [
      [
        ['s', 'a'],
        ['u', 7]
      ]
    ]);
    assert.deepStrictEqual(toPlain(values), ['a', 7]);
  });

  it('leaves an empty dict as an empty object', () => {
    const [dict] = roundTrip('a{sv}', [[]]);
    assert.deepStrictEqual(toPlain(dict), {});
  });
});

describe('Variant', () => {
  it('marshals identically to the [signature, value] pair', () => {
    assert.ok(
      marshall('v', [new Variant('s', 'hello')]).equals(
        marshall('v', [['s', 'hello']])
      )
    );
    assert.ok(
      marshall('a{sv}', [[['k', new Variant('u', 7)]]]).equals(
        marshall('a{sv}', [[['k', ['u', 7]]]])
      )
    );
  });

  it('round-trips through the wire', () => {
    const [value] = roundTrip('v', [new Variant('ai', [1, 2, 3])]);
    assert.deepStrictEqual(variantValue(value), [1, 2, 3]);
  });

  it('prints readably', () => {
    const util = require('util');
    // the point: not a wall of parse-tree objects
    assert.strictEqual(util.inspect(new Variant('y', 1)), "Variant('y', 1)");
    assert.match(util.inspect(new Variant('as', ['a'])), /^Variant\('as', \[/);
  });
});

describe('tags are invisible', () => {
  it('does not affect JSON or deep equality', () => {
    const [dict] = roundTrip('a{sv}', [[['k', ['s', 'v']]]]);
    const plainCopy = JSON.parse(JSON.stringify(dict));
    assert.deepStrictEqual(dict, JSON.parse(JSON.stringify(dict)));
    assert.strictEqual(JSON.stringify(dict), JSON.stringify(plainCopy));
    assert.deepStrictEqual(Object.keys(dict), Object.keys(plainCopy));
  });
});
