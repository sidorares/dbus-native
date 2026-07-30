// The CLI pins the value shapes it reads, rather than following the defaults.
//
// `describe()` prints a variant as `variant u 501`, and it needs the signature
// to do that. `variants: 'wrap'` is how it asks. Before that option existed the
// only way to ask was `plainValues: false`, which got the signature by reading
// the parser's internal tree -- so the CLI was pinned away from the 2.0 shapes
// to keep a feature it should not have had to trade for them.
//
// These tests are here to fail if the pin is ever dropped.

const { describe, it } = require('node:test');
const assert = require('assert');
const DBusBuffer = require('../lib/dbus-buffer');
const marshall = require('../lib/marshall');
const { Variant } = require('../lib/values');
const { SHAPE, describe: render } = require('../lib/cli/call');

// Read a value back the way the given options would read it.
const read = (signature, body, options) =>
  new DBusBuffer(marshall(signature, body), 0, options).read(signature);

describe('cli value shapes', () => {
  it('asks for the modern shapes, and for the type information', () => {
    assert.deepStrictEqual(SHAPE, {
      returnBigInt: true,
      plainValues: true,
      variants: 'wrap'
    });
  });

  it('prints a variant with its signature', () => {
    const [v] = read('v', [['u', 501]], SHAPE);
    assert.ok(v instanceof Variant);
    assert.strictEqual(render(v, 0), 'variant u 501');
  });

  it('cannot print the signature under variants: plain', () => {
    // Not a wish, a demonstration: this is what the output degrades to if the
    // pin goes away, and the reason the option exists at all.
    const [v] = read('v', [['u', 501]], { ...SHAPE, variants: 'plain' });
    assert.strictEqual(render(v, 0), '501');
  });

  it('prints a string-keyed dict the same in either dict shape', () => {
    const body = [{ Name: new Variant('s', 'eth0') }];
    const [asObject] = read('a{sv}', body, SHAPE);
    const [asPairs] = read('a{sv}', body, { ...SHAPE, plainValues: false });

    assert.ok(!Array.isArray(asObject), 'plainValues should give an object');
    assert.ok(Array.isArray(asPairs), 'without it, pairs');
    // The whole point: the reader sees one format regardless.
    assert.strictEqual(render(asObject, 0), render(asPairs, 0));
    assert.strictEqual(
      render(asObject, 0),
      '{\n  "Name" -> variant s "eth0"\n}'
    );
  });

  it('indents a nested dict under its key', () => {
    // GetManagedObjects returns a{oa{sa{sv}}}, three deep. Rendered flat --
    // every level starting at column zero -- it is unreadable.
    const body = [
      { '/dev0': { 'com.example.D': { Name: new Variant('s', 'hci0') } } }
    ];
    const [objects] = read('a{oa{sa{sv}}}', body, SHAPE);
    assert.strictEqual(
      render(objects, 0),
      [
        '{',
        '  "/dev0" -> {',
        '    "com.example.D" -> {',
        '      "Name" -> variant s "hci0"',
        '    }',
        '  }',
        '}'
      ].join('\n')
    );
  });

  it('does not round a 64-bit value on the way to the terminal', () => {
    const [value] = read('t', [18446744073709551615n], SHAPE);
    assert.strictEqual(render(value, 0), '18446744073709551615');
  });
});
