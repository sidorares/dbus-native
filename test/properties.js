// Property declarations: the widened form, and what it means.
//
// The string form (`{ Greeting: 's' }`) is what essentially every existing
// service uses, so most of what matters here is that it keeps meaning exactly
// what it did.

const { describe, it } = require('node:test');
const assert = require('assert');
const properties = require('../lib/properties');
const constants = require('../lib/constants');

const iface = props => ({ name: 'a.b.C', properties: props });

describe('property declarations', () => {
  it('reads the string form as readwrite', () => {
    assert.deepStrictEqual(properties.declaration(iface({ P: 's' }), 'P'), {
      type: 's',
      access: 'readwrite'
    });
  });

  it('reads the object form', () => {
    assert.deepStrictEqual(
      properties.declaration(iface({ P: { type: 'b', access: 'read' } }), 'P'),
      { type: 'b', access: 'read' }
    );
  });

  it('defaults the object form to readwrite', () => {
    assert.deepStrictEqual(
      properties.declaration(iface({ P: { type: 'u' } }), 'P'),
      { type: 'u', access: 'readwrite' }
    );
  });

  it('is undefined for a property that was not declared', () => {
    assert.strictEqual(
      properties.declaration(iface({ P: 's' }), 'Q'),
      undefined
    );
  });

  it('is undefined when the interface declares no properties', () => {
    assert.strictEqual(
      properties.declaration({ name: 'a.b.C' }, 'P'),
      undefined
    );
  });

  // `if (!props[name])` would call this undeclared.
  it('handles a property declared with the empty signature', () => {
    assert.deepStrictEqual(properties.declaration(iface({ P: '' }), 'P'), {
      type: '',
      access: 'readwrite'
    });
  });

  it('does not treat inherited object keys as properties', () => {
    assert.strictEqual(
      properties.declaration(iface({ P: 's' }), 'toString'),
      undefined
    );
  });

  it('rejects an unknown access value', () => {
    assert.throws(
      () =>
        properties.declaration(iface({ P: { type: 's', access: 'rw' } }), 'P'),
      /expected one of read, write, readwrite/
    );
  });

  it('rejects a declaration that is neither form', () => {
    assert.throws(
      () => properties.declaration(iface({ P: 42 }), 'P'),
      /signature string or \{ type, access \}/
    );
  });

  it('lists names in declaration order', () => {
    assert.deepStrictEqual(
      properties.names(iface({ B: 's', A: 's', C: { type: 'u' } })),
      ['B', 'A', 'C']
    );
    assert.deepStrictEqual(properties.names({ name: 'a.b.C' }), []);
  });
});

describe('property access', () => {
  it('classifies readability', () => {
    assert.ok(properties.isReadable('read'));
    assert.ok(properties.isReadable('readwrite'));
    assert.ok(!properties.isReadable('write'));
  });

  it('classifies writability', () => {
    assert.ok(properties.isWritable('write'));
    assert.ok(properties.isWritable('readwrite'));
    assert.ok(!properties.isWritable('read'));
  });
});

describe('PropertiesChanged signal', () => {
  it('has the shape the spec requires', () => {
    const sig = properties.changedSignal(
      7,
      '/a/b',
      'a.b.C',
      [['P', ['s', 'v']]],
      ['Q']
    );
    assert.strictEqual(sig.type, constants.messageType.signal);
    assert.strictEqual(sig.interface, 'org.freedesktop.DBus.Properties');
    assert.strictEqual(sig.member, 'PropertiesChanged');
    assert.strictEqual(sig.signature, 'sa{sv}as');
    assert.strictEqual(sig.path, '/a/b');
    assert.deepStrictEqual(sig.body, ['a.b.C', [['P', ['s', 'v']]], ['Q']]);
  });

  it('marshalls', () => {
    // The signature and body have to agree or this throws.
    const marshall = require('../lib/marshall');
    const sig = properties.changedSignal(1, '/a', 'a.b.C', [], []);
    assert.ok(marshall(sig.signature, sig.body).length > 0);
  });
});
