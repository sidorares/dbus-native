// Closing a connection while the SASL handshake is still in flight.
//
// Issue #20. A short-lived tool that calls `connection.end()` as soon as it
// has what it wants can close the socket between two handshake writes. The
// next write then fails with ERR_STREAM_WRITE_AFTER_END, which surfaces as an
// unhandled 'error' on the connection and takes the process down.
//
// It is a race, so in the wild it is intermittent -- it failed one CI job in
// seven on the run that surfaced it. These tests close at each point the
// handshake can be interrupted, deterministically.

const { describe, it } = require('node:test');
const assert = require('assert');
const { Duplex } = require('stream');
const dbus = require('../index');

// A socket stand-in that behaves like a real one on write-after-end: throws
// asynchronously via an 'error' event rather than returning false.
class FakeSocket extends Duplex {
  constructor() {
    super();
    this.written = [];
  }
  _write(chunk, enc, cb) {
    this.written.push(chunk.toString());
    cb();
  }
  _read() {}
  text() {
    return this.written.join('');
  }
}

// Collects anything that would have crashed the process.
function watch(conn) {
  const errors = [];
  conn.on('error', err => errors.push(err));
  return errors;
}

const settle = () => new Promise(resolve => setImmediate(resolve));

describe('closing during the handshake', () => {
  it('does not write after end when closed before the greeting reply', async () => {
    const socket = new FakeSocket();
    const conn = dbus.createConnection({ stream: socket, direct: true });
    const errors = watch(conn);

    conn.end(); // user closes immediately
    await settle();
    // The server answers anyway; the handshake must not write BEGIN now.
    socket.push('OK 0123456789abcdef\r\n');
    await settle();

    assert.deepStrictEqual(
      errors.map(e => e.code),
      [],
      `expected no error, got ${errors.map(e => e.message)}`
    );
    assert.ok(
      !socket.text().includes('BEGIN'),
      'BEGIN was written to a closed stream'
    );
  });

  it('does not write after end when closed mid-authentication', async () => {
    const socket = new FakeSocket();
    const conn = dbus.createConnection({ stream: socket, direct: true });
    const errors = watch(conn);

    await settle();
    // AUTH EXTERNAL has gone out; close before the server replies.
    assert.ok(socket.text().includes('AUTH'), 'expected AUTH to be sent first');
    conn.end();
    await settle();
    socket.push('REJECTED EXTERNAL DBUS_COOKIE_SHA1 ANONYMOUS\r\n');
    await settle();

    assert.deepStrictEqual(
      errors.map(e => e.code),
      [],
      `expected no error, got ${errors.map(e => e.message)}`
    );
  });

  it('does not crash when the socket is destroyed outright', async () => {
    const socket = new FakeSocket();
    const conn = dbus.createConnection({ stream: socket, direct: true });
    const errors = watch(conn);

    await settle();
    socket.destroy();
    await settle();
    socket.push('OK 0123456789abcdef\r\n');
    await settle();

    assert.ok(
      !errors.some(e => e.code === 'ERR_STREAM_WRITE_AFTER_END'),
      'write-after-end escaped'
    );
  });

  // The fix must not break the ordinary path.
  it('still completes a handshake that is not interrupted', async () => {
    const socket = new FakeSocket();
    const conn = dbus.createConnection({ stream: socket, direct: true });
    const connected = new Promise(resolve => conn.once('connect', resolve));

    await settle();
    socket.push('OK 0123456789abcdef\r\n');
    await connected;

    assert.strictEqual(conn.guid, '0123456789abcdef');
    assert.ok(socket.text().includes('BEGIN'), 'BEGIN should still be sent');
  });
});
