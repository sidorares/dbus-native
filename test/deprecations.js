const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');
const deprecate = require('../lib/deprecate');

describe('deprecate()', () => {
  beforeEach(() => deprecate.reset());

  // process.emitWarning fires on a later tick, so the listener has to stay
  // attached across it.
  const capture = async fn => {
    const seen = [];
    const listener = w => seen.push(w);
    process.on('warning', listener);
    try {
      fn();
      await new Promise(setImmediate);
    } finally {
      process.removeListener('warning', listener);
    }
    return seen;
  };

  it('emits a DeprecationWarning with a code and a docs link', async () => {
    const seen = await capture(() =>
      deprecate('DBUS_DEP9999', 'Test deprecation.')
    );
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].name, 'DeprecationWarning');
    assert.strictEqual(seen[0].code, 'DBUS_DEP9999');
    assert.match(seen[0].message, /Test deprecation\./);
    assert.match(seen[0].message, /docs\/deprecations\.md#dbus_dep9999/);
  });

  it('warns once per code, not once per call', async () => {
    const seen = await capture(() => {
      for (let i = 0; i < 5; i++) deprecate('DBUS_DEP9998', 'Repeated.');
    });
    assert.strictEqual(seen.length, 1);
  });
});

// DBUS_DEP0001 was the one deprecation that reached the end of its life. It
// warned from 0.6 and the option it named was removed in 2.0, so the test that
// checked the warning is now a test that checks the error -- see
// test/bigint.js, where it sits with the rest of the 64-bit behaviour.
//
// The linter still carries the rule (test/lint.js): a code that has been
// removed is exactly the one worth finding call sites for.
