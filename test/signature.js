const { describe, it } = require('node:test');
const assert = require('assert');
const parseSignature = require('../lib/signature');
const unmarshall = require('../lib/unmarshall');
const marshall = require('../lib/marshall');

describe('Signature parser', () => {
  it('parses a simple sequence', () => {
    assert.deepStrictEqual(parseSignature('yu'), [
      { type: 'y', child: [] },
      { type: 'u', child: [] }
    ]);
  });

  it('parses an empty signature', () => {
    assert.deepStrictEqual(parseSignature(''), []);
  });

  it('parses arrays, structs and dict entries', () => {
    assert.deepStrictEqual(parseSignature('a{sv}'), [
      {
        type: 'a',
        child: [
          {
            type: '{',
            child: [
              { type: 's', child: [] },
              { type: 'v', child: [] }
            ]
          }
        ]
      }
    ]);
    assert.deepStrictEqual(parseSignature('(ii)'), [
      {
        type: '(',
        child: [
          { type: 'i', child: [] },
          { type: 'i', child: [] }
        ]
      }
    ]);
  });

  it('rejects an unknown type', () => {
    assert.throws(() => parseSignature('z'), /Unknown type/);
  });

  it('rejects an unterminated container', () => {
    assert.throws(() => parseSignature('(ii'), /unexpected end/);
    assert.throws(() => parseSignature('a'), /unexpected end/);
  });
});

describe('Signature cache', () => {
  it('returns the same tree for the same signature', () => {
    assert.strictEqual(parseSignature('a{sv}'), parseSignature('a{sv}'));
  });

  it('returns different trees for different signatures', () => {
    assert.notStrictEqual(parseSignature('ai'), parseSignature('as'));
  });

  // readVariant hands the tree to application code, so a shared entry must
  // not be mutable or one caller could corrupt every other user of it.
  it('deep-freezes cached trees', () => {
    const tree = parseSignature('a(is)');
    assert.ok(Object.isFrozen(tree), 'top level frozen');
    assert.ok(Object.isFrozen(tree[0]), 'node frozen');
    assert.ok(Object.isFrozen(tree[0].child), 'child array frozen');
    assert.ok(Object.isFrozen(tree[0].child[0].child[0]), 'leaf frozen');
  });

  it('survives an attempt to mutate a returned tree', () => {
    const tree = parseSignature('ai');
    try {
      tree[0].type = 'X';
      tree.push({ type: 'q', child: [] });
    } catch {
      // strict-mode callers get a TypeError; either way nothing changes
    }
    assert.strictEqual(parseSignature('ai')[0].type, 'a');
    assert.strictEqual(parseSignature('ai').length, 1);
  });

  it('does not cache signatures that fail to parse', () => {
    assert.throws(() => parseSignature('a{sv'), /unexpected end/);
    assert.throws(() => parseSignature('a{sv'), /unexpected end/);
  });

  it('exposes an uncached parser returning a fresh mutable tree', () => {
    const a = parseSignature.uncached('ai');
    const b = parseSignature.uncached('ai');
    assert.notStrictEqual(a, b);
    assert.ok(!Object.isFrozen(a));
    assert.deepStrictEqual(a, b);
  });

  // Signatures come from the peer, so the cache must not grow without bound.
  it('bounds the cache', () => {
    const before = parseSignature.cacheSize();
    for (let i = 0; i < 1500; i++) {
      // each distinct, and each a valid signature
      parseSignature(
        `(${'i'.repeat((i % 40) + 1)}${'u'.repeat((i % 7) + 1)})${'y'.repeat((i % 11) + 1)}`
      );
    }
    const after = parseSignature.cacheSize();
    assert.ok(after <= 1000, `cache grew to ${after}`);
    assert.ok(after >= before, 'cache is still populated');
  });

  it('still round-trips correctly after eviction churn', () => {
    const buf = marshall('a{sv}', [[['k', ['s', 'v']]]]);
    assert.deepStrictEqual(unmarshall(buf, 'a{sv}')[0], { k: 'v' });
  });
});
