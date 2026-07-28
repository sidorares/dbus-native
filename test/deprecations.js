const assert = require('assert');
const { execFileSync } = require('child_process');
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

describe('DBUS_DEP0001 (ReturnLongjs)', () => {
  // Run in a child so --throw-deprecation is in effect from the start, which
  // is the workflow the docs tell users to adopt.
  it('is thrown under --throw-deprecation, pointing at the caller', () => {
    const script = `
      const dbus = require(${JSON.stringify(require.resolve('../index'))});
      const { PassThrough } = require('stream');
      dbus.createConnection({ stream: new PassThrough(), ReturnLongjs: true });
    `;
    let stderr = '';
    try {
      execFileSync(process.execPath, ['--throw-deprecation', '-e', script], {
        encoding: 'utf8',
        stdio: 'pipe'
      });
      assert.fail('expected the deprecation to throw');
    } catch (err) {
      stderr = err.stderr || '';
    }
    assert.match(stderr, /DBUS_DEP0001/);
    assert.match(stderr, /ReturnLongjs/);
    assert.match(stderr, /BigInt/);
  });

  it('does not warn when the option is not used', async () => {
    deprecate.reset();
    const { Duplex } = require('stream');
    // Not a PassThrough: that echoes the client's own AUTH line back at it,
    // which sends the handshake down the DBUS_COOKIE_SHA1 path and fails on a
    // missing ~/.dbus-keyrings (issue #158). A stream that never answers is
    // the right fixture here -- we only care that construction does not warn.
    const silent = new Duplex({
      read() {},
      write(chunk, enc, cb) {
        cb();
      }
    });
    const seen = [];
    const listener = w => seen.push(w);
    process.on('warning', listener);
    try {
      const conn = require('../index').createConnection({ stream: silent });
      conn.on('error', () => {});
      await new Promise(setImmediate);
    } finally {
      process.removeListener('warning', listener);
    }
    assert.deepStrictEqual(
      seen.filter(w => w.code === 'DBUS_DEP0001'),
      []
    );
  });
});
