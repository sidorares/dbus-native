// The public export surface.
//
// index.d.ts declares these, but a declaration file cannot notice that
// index.js never actually exported the value -- tsc type-checks against the
// .d.ts regardless. That gap shipped in 0.6: DBusError was documented, typed,
// and undefined at runtime. This asserts the runtime side.

const assert = require('assert');
const dbus = require('../index');

describe('public exports', () => {
  it('exports the error classes so instanceof works', () => {
    for (const name of ['DBusError', 'TimeoutError', 'AbortError']) {
      assert.strictEqual(typeof dbus[name], 'function', `${name} is exported`);
    }
    assert.ok(new dbus.TimeoutError(1, {}) instanceof dbus.DBusError);
    assert.ok(new dbus.DBusError('x') instanceof Error);
  });

  it('exports the value helpers', () => {
    for (const name of [
      'Variant',
      'variantValue',
      'variantSignature',
      'toPlain'
    ]) {
      assert.strictEqual(typeof dbus[name], 'function', `${name} is exported`);
    }
  });

  it('exports the entry points', () => {
    for (const name of [
      'createClient',
      'sessionBus',
      'systemBus',
      'createConnection',
      'createServer'
    ]) {
      assert.strictEqual(typeof dbus[name], 'function', `${name} is exported`);
    }
    assert.strictEqual(typeof dbus.messageType, 'object');
  });
});
