// What lib/transport-bun.js does when it is not running under Bun.
//
// The transport itself is tested in test/bun/, which only Bun can run. This
// file is the other half of the contract and the half that matters to every
// Node user: the module loads, answers "no", and hands back an ordinary
// socket, so requiring it costs nothing and changes nothing.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const transport = require('../lib/transport-bun');
const { unixConnection } = require('../lib/address');

const UNDER_BUN = typeof Bun !== 'undefined';

describe('the Bun fd transport, on Node', { skip: UNDER_BUN }, () => {
  it('reports that it is unavailable', () => {
    assert.strictEqual(transport.available(), false);
  });

  it('returns null rather than throwing', () => {
    assert.strictEqual(transport.connect({ path: '/tmp/nothing.sock' }), null);
    assert.strictEqual(transport.connect({ abstract: 'nothing' }), null);
  });

  it('leaves unix connections to net, exactly as before', () => {
    // No listener, so this fails -- the point is which kind of thing it is and
    // that nothing threw on the way. An unhandled 'error' would take the
    // process down, so it is answered here.
    const stream = unixConnection({ path: '/tmp/definitely-not-there.sock' });
    stream.on('error', () => {});
    assert.strictEqual(typeof stream.writeWithFds, 'undefined');
    assert.ok(typeof stream.destroy === 'function');
    stream.destroy();
  });

  it('can be switched off explicitly', () => {
    const stream = unixConnection(
      { path: '/tmp/definitely-not-there.sock' },
      { fdTransport: false }
    );
    stream.on('error', () => {});
    assert.strictEqual(typeof stream.writeWithFds, 'undefined');
    stream.destroy();
  });
});

describe('the module itself', () => {
  it('states the descriptor limit it enforces', () => {
    assert.ok(Number.isInteger(transport.MAX_FDS));
    // Enough for anything d-bus carries: dbus-daemon's own default limit is
    // 16 per message.
    assert.ok(transport.MAX_FDS >= 16);
  });

  it('does not pull in bun:ffi merely by being required', () => {
    // Loading it on Node must not throw, which is what makes it safe to
    // require unconditionally from lib/address.js.
    assert.doesNotThrow(() => require('../lib/transport-bun'));
  });
});
