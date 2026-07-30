// Reading big-endian messages.
//
// The fixtures here are assembled by hand with Node's own writeUInt32BE etc.
// rather than by round-tripping through this library, so the test cannot pass
// just because a writer and a reader share the same mistake.

const { describe, it } = require('node:test');
const assert = require('assert');
const { PassThrough } = require('stream');
const message = require('../lib/message');
const constants = require('../lib/constants');
const DBusBuffer = require('../lib/dbus-buffer');

const BE = constants.endianness.be;
const LE = constants.endianness.le;

describe('DBusBuffer: big-endian scalars', () => {
  const read = (bytes, signature, endianness) =>
    new DBusBuffer(Buffer.from(bytes), 0, {}, endianness).read(signature)[0];

  it('reads uint32', () => {
    assert.strictEqual(read([0x00, 0x00, 0x00, 0x01], 'u', BE), 1);
    assert.strictEqual(read([0x00, 0x00, 0x00, 0x01], 'u', LE), 0x01000000);
    assert.strictEqual(read([0x12, 0x34, 0x56, 0x78], 'u', BE), 0x12345678);
  });

  it('reads int32', () => {
    assert.strictEqual(read([0xff, 0xff, 0xff, 0xff], 'i', BE), -1);
    assert.strictEqual(read([0x80, 0x00, 0x00, 0x00], 'i', BE), -2147483648);
  });

  it('reads uint16 and int16', () => {
    assert.strictEqual(read([0x01, 0x02], 'q', BE), 0x0102);
    assert.strictEqual(read([0x01, 0x02], 'q', LE), 0x0201);
    assert.strictEqual(read([0xff, 0xfe], 'n', BE), -2);
  });

  it('reads a double', () => {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(3.141592653589793, 0);
    assert.strictEqual(read([...bytes], 'd', BE), 3.141592653589793);
  });

  it('reads a boolean', () => {
    assert.strictEqual(read([0x00, 0x00, 0x00, 0x01], 'b', BE), true);
    assert.strictEqual(read([0x00, 0x00, 0x00, 0x00], 'b', BE), false);
  });

  // Both the bytes within each 32-bit word and the order of the two words
  // flip, which is easy to get half right.
  it('reads 64-bit values with the correct word order', () => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64BE(0x0000000100000002n, 0);
    assert.strictEqual(read([...bytes], 'x', BE), 0x0000000100000002n);

    // The top word is the one a half-right implementation loses, so read the
    // full range rather than a value a 32-bit slip could still get right.
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(18446744073709551615n, 0);
    assert.strictEqual(read([...big], 't', BE), 18446744073709551615n);

    const negative = Buffer.alloc(8);
    negative.writeBigInt64BE(-42n, 0);
    assert.strictEqual(read([...negative], 'x', BE), -42n);
  });

  it('reads a string, whose length field is byte-order sensitive', () => {
    // length 5 big-endian, then "hello\0"
    const bytes = [0, 0, 0, 5, ...Buffer.from('hello'), 0];
    assert.strictEqual(read(bytes, 's', BE), 'hello');
  });

  it('reads an array, whose length field is byte-order sensitive', () => {
    // 8 bytes of body big-endian, then two uint32 elements
    const bytes = [0, 0, 0, 8, 0, 0, 0, 1, 0, 0, 0, 2];
    assert.deepStrictEqual(read(bytes, 'au', BE), [1, 2]);
  });
});

// Build a complete big-endian method call by hand.
//
//   'B', type=1, flags=0, version=1, bodyLength, serial, fieldsLength
//   then a(yv) header fields, padded to 8, then the body.
function bigEndianMethodCall() {
  const fields = [];

  // one a(yv) entry: struct, 8-aligned, a byte code then a variant
  const field = (code, sigChar, value) => {
    while (fields.length % 8 !== 0) fields.push(0); // struct alignment
    fields.push(code);
    fields.push(1, sigChar.charCodeAt(0), 0); // variant signature: len, char, NUL
    const bytes = Buffer.from(value, 'utf8');
    if (sigChar === 'g') {
      // a signature is length-prefixed with a single byte and is not aligned
      fields.push(bytes.length, ...bytes, 0);
      return;
    }
    // 's' and 'o' take a 4-byte length, aligned to 4 within the message
    while ((fields.length + 16) % 4 !== 0) fields.push(0);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0); // <- big-endian length
    fields.push(...len, ...bytes, 0);
  };

  field(1, 'o', '/com/example/Path'); // PATH
  field(2, 's', 'com.example.Iface'); // INTERFACE
  field(3, 's', 'BigEndianPing'); // MEMBER
  field(8, 'g', 's'); // SIGNATURE

  const fieldsLength = fields.length;
  while (fields.length % 8 !== 0) fields.push(0); // pad before the body

  const bodyText = Buffer.from('sent big-endian', 'utf8');
  const body = Buffer.alloc(4 + bodyText.length + 1);
  body.writeUInt32BE(bodyText.length, 0); // <- big-endian length
  bodyText.copy(body, 4);

  const header = Buffer.alloc(16);
  header[0] = BE;
  header[1] = constants.messageType.methodCall;
  header[2] = 0;
  header[3] = constants.protocolVersion;
  header.writeUInt32BE(body.length, 4);
  header.writeUInt32BE(0x11223344, 8); // serial, deliberately asymmetric
  header.writeUInt32BE(fieldsLength, 12);

  return Buffer.concat([header, Buffer.from(fields), body]);
}

describe('big-endian messages', () => {
  const expected = {
    path: '/com/example/Path',
    interface: 'com.example.Iface',
    member: 'BigEndianPing',
    signature: 's',
    serial: 0x11223344,
    body: ['sent big-endian']
  };

  it('message.unmarshall reads one', () => {
    const msg = message.unmarshall(bigEndianMethodCall());
    assert.strictEqual(msg.path, expected.path);
    assert.strictEqual(msg.interface, expected.interface);
    assert.strictEqual(msg.member, expected.member);
    assert.strictEqual(msg.serial, expected.serial);
    assert.deepStrictEqual(msg.body, expected.body);
    assert.strictEqual(msg.type, constants.messageType.methodCall);
  });

  it('the streaming parser reads one', (t, done) => {
    const stream = new PassThrough();
    message.unmarshalMessages(
      stream,
      msg => {
        assert.strictEqual(msg.member, expected.member);
        assert.strictEqual(msg.serial, expected.serial);
        assert.deepStrictEqual(msg.body, expected.body);
        done();
      },
      {},
      done
    );
    stream.write(bigEndianMethodCall());
  });

  it('reads one split across chunk boundaries', (t, done) => {
    const buf = bigEndianMethodCall();
    const stream = new PassThrough();
    message.unmarshalMessages(
      stream,
      msg => {
        assert.strictEqual(msg.member, expected.member);
        done();
      },
      {},
      done
    );
    stream.write(buf.subarray(0, 7));
    stream.write(buf.subarray(7, 19));
    stream.write(buf.subarray(19));
  });

  it('interleaves with little-endian messages on the same connection', (t, done) => {
    const le = message.marshall({
      serial: 7,
      type: constants.messageType.methodCall,
      path: '/le',
      destination: 'a.b',
      interface: 'a.b',
      member: 'LittleEndianPing',
      signature: 's',
      body: ['sent little-endian']
    });
    const seen = [];
    const stream = new PassThrough();
    message.unmarshalMessages(
      stream,
      msg => {
        seen.push([msg.member, msg.body[0]]);
        if (seen.length === 3) {
          assert.deepStrictEqual(seen, [
            ['BigEndianPing', 'sent big-endian'],
            ['LittleEndianPing', 'sent little-endian'],
            ['BigEndianPing', 'sent big-endian']
          ]);
          done();
        }
      },
      {},
      done
    );
    stream.write(
      Buffer.concat([bigEndianMethodCall(), le, bigEndianMethodCall()])
    );
  });

  it('still rejects a byte order that is neither', () => {
    const bad = bigEndianMethodCall();
    bad[0] = 0x41; // 'A'
    assert.throws(() => message.unmarshall(bad), /Invalid byte order/);
  });
});
