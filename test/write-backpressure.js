// The write path: does message() report backpressure, and are writes issued
// in the same tick batched into one flush?

const { describe, it } = require('node:test');
const assert = require('assert');
const { Duplex } = require('stream');
const dbus = require('../index');
const constants = require('../lib/constants');

// A socket stand-in that records how many times the stream layer handed it
// data, and can be told to stall so its buffer fills up.
class FakeSocket extends Duplex {
  constructor(options = {}) {
    super({ highWaterMark: options.highWaterMark });
    this.writeCalls = 0;
    this.writevCalls = 0;
    this.written = [];
    this.stalled = options.stalled === true;
    this.pending = [];
  }
  _write(chunk, enc, cb) {
    this.writeCalls++;
    this.written.push(chunk);
    if (this.stalled) this.pending.push(cb);
    else cb();
  }
  _writev(chunks, cb) {
    this.writevCalls++;
    for (const c of chunks) this.written.push(c.chunk);
    if (this.stalled) this.pending.push(cb);
    else cb();
  }
  _read() {}
  // let the queued writes complete, which triggers 'drain'
  release() {
    this.stalled = false;
    const cbs = this.pending.splice(0);
    for (const cb of cbs) cb();
  }
  bytesWritten() {
    return this.written.reduce((n, c) => n + c.length, 0);
  }
}

// Complete the SASL handshake by hand so the connection reaches 'connect'.
function connect(socket) {
  return new Promise(resolve => {
    const conn = dbus.createConnection({ stream: socket, direct: true });
    // The client opens with "\0AUTH EXTERNAL <hex>\r\n"; any OK completes it.
    setImmediate(() => socket.push('OK 0123456789abcdef\r\n'));
    conn.once('connect', () => resolve(conn));
  });
}

const call = serial => ({
  serial,
  type: constants.messageType.methodCall,
  path: '/p',
  destination: 'a.b',
  interface: 'a.b',
  member: 'M',
  signature: 's',
  body: ['payload']
});

describe('write backpressure', () => {
  it('returns true while the socket keeps up', async () => {
    const socket = new FakeSocket();
    const conn = await connect(socket);
    assert.strictEqual(conn.message(call(1)), true);
  });

  it('returns false once the socket buffer is over the high water mark', async () => {
    const socket = new FakeSocket({ highWaterMark: 256, stalled: true });
    const conn = await connect(socket);

    let sawFalse = false;
    for (let i = 1; i <= 50 && !sawFalse; i++) {
      sawFalse = conn.message(call(i)) === false;
    }
    assert.ok(sawFalse, 'message() never reported backpressure');
  });

  it("emits 'drain' when the socket catches up", async () => {
    const socket = new FakeSocket({ highWaterMark: 256, stalled: true });
    const conn = await connect(socket);

    const drained = new Promise(resolve => conn.once('drain', resolve));
    for (let i = 1; i <= 50; i++) conn.message(call(i));
    await new Promise(setImmediate); // let the cork flush
    socket.release();
    await drained; // times out the test if never emitted
  });

  it('batches messages written in the same tick into one flush', async () => {
    const socket = new FakeSocket();
    const conn = await connect(socket);
    socket.writeCalls = 0;
    socket.writevCalls = 0;

    for (let i = 1; i <= 10; i++) conn.message(call(i));
    await new Promise(setImmediate);

    assert.strictEqual(
      socket.writevCalls,
      1,
      `expected one batched flush, got ${socket.writevCalls} writev + ${socket.writeCalls} write`
    );
    assert.strictEqual(socket.writeCalls, 0);
  });

  it('writes messages in separate ticks separately', async () => {
    const socket = new FakeSocket();
    const conn = await connect(socket);
    socket.writeCalls = 0;
    socket.writevCalls = 0;

    conn.message(call(1));
    await new Promise(setImmediate);
    conn.message(call(2));
    await new Promise(setImmediate);

    assert.strictEqual(socket.writeCalls + socket.writevCalls, 2);
  });

  it('delivers every byte despite the batching', async () => {
    const socket = new FakeSocket();
    const conn = await connect(socket);
    socket.written.length = 0;

    const expected = [];
    for (let i = 1; i <= 5; i++) {
      const msg = call(i);
      expected.push(require('../lib/message').marshall(msg));
      conn.message(msg);
    }
    await new Promise(setImmediate);

    assert.ok(
      Buffer.concat(socket.written).equals(Buffer.concat(expected)),
      'bytes on the wire differ from the marshalled messages'
    );
  });

  it('does not throw if the stream is destroyed before the flush', async () => {
    const socket = new FakeSocket();
    const conn = await connect(socket);
    conn.message(call(1));
    socket.destroy();
    await new Promise(setImmediate);
    // reaching here without an uncork-after-destroy throw is the assertion
  });

  it('reports false after the stream has ended', async () => {
    const socket = new FakeSocket();
    const conn = await connect(socket);
    socket.push(null);
    await new Promise(resolve => conn.once('end', resolve));
    assert.strictEqual(conn.message(call(1)), false);
  });
});
