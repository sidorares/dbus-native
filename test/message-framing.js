// Framing and malformed-input handling for the message parser.
//
// Every case here crashed the process (or silently produced wrong data)
// before the read loop was hardened.

const { describe, it } = require('node:test');
const assert = require('assert');
const { PassThrough, Duplex } = require('stream');
const { execFile } = require('child_process');
const dbus = require('../index');
const message = require('../lib/message');
const constants = require('../lib/constants');
const DBusBuffer = require('../lib/dbus-buffer');

const methodCall = (over = {}) =>
  message.marshall({
    serial: 1,
    type: constants.messageType.methodCall,
    path: '/org/freedesktop/DBus',
    destination: 'org.freedesktop.DBus',
    interface: 'org.freedesktop.DBus',
    member: 'Hello',
    ...over
  });

// A 16 byte header with the lengths we want to claim, little-endian.
function header({ bodyLength = 0, fieldsLength = 0, serial = 1 }) {
  const h = Buffer.alloc(16);
  h[0] = constants.endianness.le;
  h[1] = constants.messageType.methodCall;
  h[2] = 0;
  h[3] = constants.protocolVersion;
  h.writeUInt32LE(bodyLength, 4);
  h.writeUInt32LE(serial, 8);
  h.writeUInt32LE(fieldsLength, 12);
  return h;
}

// Drive the parser and report what came out, without letting a throw escape
// into the test runner's uncaught handler.
function parse(chunks, opts) {
  return new Promise(resolve => {
    const stream = new PassThrough();
    const messages = [];
    const errors = [];
    message.unmarshalMessages(
      stream,
      m => messages.push(m),
      opts,
      e => errors.push(e)
    );
    for (const chunk of chunks) stream.write(chunk);
    setImmediate(() => resolve({ messages, errors }));
  });
}

describe('message framing', () => {
  it('parses a well-formed message', async () => {
    const { messages, errors } = await parse([methodCall()]);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].member, 'Hello');
  });

  it('parses several messages from one chunk', async () => {
    const two = Buffer.concat([
      methodCall({ serial: 1 }),
      methodCall({ serial: 2 })
    ]);
    const { messages, errors } = await parse([two]);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(
      messages.map(m => m.serial),
      [1, 2]
    );
  });

  it('parses a message split across chunk boundaries', async () => {
    const buf = methodCall();
    const chunks = [buf.subarray(0, 5), buf.subarray(5, 17), buf.subarray(17)];
    const { messages, errors } = await parse(chunks);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(messages.length, 1);
  });

  it('waits, without error, for an incomplete message', async () => {
    const buf = methodCall();
    const { messages, errors } = await parse([buf.subarray(0, 20)]);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(messages, []);
  });

  it('reports a body larger than the maximum message size', async () => {
    const { messages, errors } = await parse([
      header({ bodyLength: constants.maxMessageSize + 1, fieldsLength: 8 })
    ]);
    assert.deepStrictEqual(messages, []);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'EPROTO');
    assert.match(errors[0].message, /maximum size/);
  });

  it('reports header fields larger than the maximum message size', async () => {
    const { errors } = await parse([
      header({ fieldsLength: constants.maxMessageSize + 1 })
    ]);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'EPROTO');
  });

  // ((n + 7) >> 3) << 3 wraps to int32 and produced a negative padded length,
  // which then reached stream.read() as a negative size.
  it('does not overflow when padding a huge declared field length', async () => {
    const { errors } = await parse([header({ fieldsLength: 0xfffffff0 })]);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'EPROTO');
    assert.doesNotMatch(errors[0].message, /-\d/, 'length went negative');
  });

  it('reports the combined size when each part is individually legal', async () => {
    const half = Math.floor(constants.maxMessageSize / 2) + 16;
    const { errors } = await parse([
      header({ bodyLength: half, fieldsLength: half })
    ]);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'EPROTO');
  });

  it('honours a caller-supplied maxMessageSize', async () => {
    const { errors } = await parse([methodCall()], { maxMessageSize: 32 });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'EPROTO');
  });

  // Big-endian is now read properly (see test/big-endian.js); anything that is
  // neither 'l' nor 'B' is still a protocol error.
  it('rejects an invalid byte order flag', async () => {
    for (const flag of [0x00, 0x41, 0xff]) {
      const bad = methodCall();
      bad[0] = flag;
      const { messages, errors } = await parse([bad]);
      assert.deepStrictEqual(messages, [], `flag 0x${flag.toString(16)}`);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].code, 'EPROTO');
      assert.match(errors[0].message, /byte order/);
    }
  });

  it('rejects an unsupported protocol version', async () => {
    const bad = methodCall();
    bad[3] = 2;
    const { messages, errors } = await parse([bad]);
    assert.deepStrictEqual(messages, []);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'EPROTO');
    assert.match(errors[0].message, /protocol version/);
  });

  it('stops parsing after a framing error', async () => {
    const { messages, errors } = await parse([
      header({ fieldsLength: 0xfffffff0 }),
      methodCall({ serial: 7 })
    ]);
    assert.strictEqual(errors.length, 1, 'reports exactly once');
    assert.deepStrictEqual(messages, [], 'delivers nothing after the error');
  });

  it('routes a handler exception away from the framing channel', async () => {
    const stream = new PassThrough();
    const framing = [];
    const handler = [];
    message.unmarshalMessages(
      stream,
      () => {
        throw new Error('application bug');
      },
      {},
      e => framing.push(e),
      e => handler.push(e)
    );
    stream.write(methodCall());
    await new Promise(setImmediate);
    assert.deepStrictEqual(framing, [], 'not reported as a framing error');
    assert.strictEqual(handler.length, 1);
    assert.strictEqual(handler[0].message, 'application bug');
  });

  it('keeps parsing the read buffer after a handler throws', async () => {
    const stream = new PassThrough();
    const seen = [];
    const handler = [];
    message.unmarshalMessages(
      stream,
      msg => {
        seen.push(msg.serial);
        if (msg.serial === 1) throw new Error('application bug');
      },
      {},
      () => {},
      e => handler.push(e)
    );
    // Both messages arrive in a single chunk: the second used to be discarded
    // when the first handler unwound through the parser.
    stream.write(
      Buffer.concat([methodCall({ serial: 1 }), methodCall({ serial: 2 })])
    );
    await new Promise(setImmediate);
    assert.deepStrictEqual(seen, [1, 2], 'second message still delivered');
    assert.strictEqual(handler.length, 1);
  });
});

describe('connection error handling', () => {
  // Drive a connection over a fake socket: complete the auth handshake by
  // hand, then inject bytes and watch what the connection does.
  function connect(cb) {
    const toClient = new PassThrough();
    const fromClient = new PassThrough();
    const socket = Duplex.from({ readable: toClient, writable: fromClient });
    const conn = dbus.createConnection({ stream: socket, direct: true });
    // The client sends "\0AUTH EXTERNAL <hex>\r\n"; any OK completes it.
    fromClient.once('data', () => toClient.write('OK 0123456789abcdef\r\n'));
    conn.once('connect', () => cb(conn, toClient));
    return conn;
  }

  it('emits a framing error on the connection instead of crashing', (t, done) => {
    connect((conn, toClient) => {
      conn.on('error', err => {
        assert.strictEqual(err.code, 'EPROTO');
        assert.match(err.message, /maximum size/);
        done();
      });
      toClient.write(header({ fieldsLength: 0xfffffff0 }));
    });
  });

  it('delivers well-formed messages over the same path', (t, done) => {
    connect((conn, toClient) => {
      conn.on('error', done);
      conn.on('message', msg => {
        assert.strictEqual(msg.member, 'Hello');
        done();
      });
      toClient.write(methodCall());
    });
  });

  it("reports a throwing listener on 'handlerError', not 'error'", (t, done) => {
    connect((conn, toClient) => {
      conn.on('error', () => done(new Error("went to 'error'")));
      conn.on('message', () => {
        throw new Error('bug in a message listener');
      });
      conn.on('handlerError', err => {
        assert.strictEqual(err.message, 'bug in a message listener');
        done();
      });
      toClient.write(methodCall());
    });
  });

  // With no 'handlerError' listener we must not silently swallow an
  // application bug -- Node's default for a throwing listener is to crash.
  // Run it in a child process so the crash is observable.
  // Spawns a child process, so it needs longer than the default.
  it(
    'still crashes by default when nothing listens for handlerError',
    { timeout: 10000 },
    (t, done) => {
      const script = `
      const { PassThrough, Duplex } = require('stream');
      const dbus = require(${JSON.stringify(require.resolve('../index'))});
      const message = require(${JSON.stringify(require.resolve('../lib/message'))});
      const toClient = new PassThrough();
      const fromClient = new PassThrough();
      const socket = Duplex.from({ readable: toClient, writable: fromClient });
      const conn = dbus.createConnection({ stream: socket, direct: true });
      fromClient.once('data', () => toClient.write('OK 0123456789abcdef\\r\\n'));
      conn.once('connect', () => {
        conn.on('message', () => { throw new Error('unhandled listener bug'); });
        toClient.write(message.marshall({
          serial: 1, type: 1, path: '/p', destination: 'a.b',
          interface: 'a.b', member: 'Hello'
        }));
      });
      setTimeout(() => process.exit(0), 1000);
    `;
      execFile(process.execPath, ['-e', script], (err, stdout, stderr) => {
        assert.ok(err, 'expected a non-zero exit');
        assert.match(stderr, /unhandled listener bug/);
        done();
      });
    }
  );
});

describe('message.unmarshall', () => {
  it('reads a message that has a body', () => {
    const buf = methodCall({ signature: 's', body: ['hi'] });
    const m = message.unmarshall(buf);
    assert.strictEqual(m.member, 'Hello');
    assert.deepStrictEqual(m.body, ['hi']);
  });

  // Hello, Ping, ListNames and every other argument-less call carry no
  // signature header field, and this used to throw on all of them.
  it('reads a message with no body', () => {
    const m = message.unmarshall(methodCall());
    assert.strictEqual(m.member, 'Hello');
    assert.strictEqual(m.body, undefined);
  });
});

describe('DBusBuffer options handling', () => {
  it('does not mutate the caller options object', () => {
    // A connection passes its own opts straight through to every message.
    const opts = { returnBigInt: false };
    const before = JSON.stringify(opts);
    message.unmarshall(methodCall({ signature: 's', body: ['x'] }), opts);
    assert.strictEqual(JSON.stringify(opts), before, 'opts gained a property');
    assert.ok(!('ayBuffer' in opts));
  });

  it('tolerates null options', () => {
    // typeof null === 'object', which used to slip past the guard
    assert.doesNotThrow(() =>
      new DBusBuffer(Buffer.alloc(4), 0, null).read('u')
    );
  });

  it('tolerates undefined and non-object options', () => {
    assert.doesNotThrow(() => new DBusBuffer(Buffer.alloc(4), 0).read('u'));
    assert.doesNotThrow(() => new DBusBuffer(Buffer.alloc(4), 0, 7).read('u'));
  });

  it('still defaults ayBuffer to true', () => {
    const buf = require('../lib/marshall')('ay', [Buffer.from([1, 2, 3])]);
    assert.ok(Buffer.isBuffer(new DBusBuffer(buf, 0, {}).read('ay')[0]));
  });
});

describe('unmarshall with an empty signature', () => {
  it('returns an empty list, like every other signature', () => {
    const unmarshall = require('../lib/unmarshall');
    assert.deepStrictEqual(unmarshall(Buffer.alloc(0), ''), []);
  });
});

describe('DBusBuffer bounds checking', () => {
  it('rejects a string length that runs past the end of the buffer', () => {
    const b = Buffer.alloc(16);
    b.writeUInt32LE(0xffffff, 0); // claim a 16MB string in a 16 byte buffer
    assert.throws(
      () => new DBusBuffer(b, 0, {}).read('s'),
      /runs past the end of the message/
    );
  });

  it('rejects an array length that runs past the end of the buffer', () => {
    const b = Buffer.alloc(16);
    b.writeUInt32LE(0xffff, 0);
    assert.throws(
      () => new DBusBuffer(b, 0, {}).read('ai'),
      /runs past the end of the message/
    );
  });

  it('rejects an array larger than the maximum array size', () => {
    const b = Buffer.alloc(16);
    b.writeUInt32LE(constants.maxArraySize + 1, 0);
    assert.throws(
      () => new DBusBuffer(b, 0, {}).read('ai'),
      /exceeds the maximum/
    );
  });

  it('still reads a legitimate empty string', () => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(0, 0);
    assert.deepStrictEqual(new DBusBuffer(b, 0, {}).read('s'), ['']);
  });
});
