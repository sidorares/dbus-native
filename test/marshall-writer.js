// Properties of the cursor-based marshaller that the round-trip tests in
// unmarshall-basic.js would not catch on their own.

const { describe, it } = require('node:test');
const assert = require('assert');
const marshall = require('../lib/marshall');
const unmarshall = require('../lib/unmarshall');
const Writer = require('../lib/writer');

describe('marshall: byte arrays', () => {
  const bytes = [0, 1, 2, 127, 128, 254, 255];

  it('produces the same bytes from a Buffer as from a plain array', () => {
    assert.ok(
      marshall('ay', [Buffer.from(bytes)]).equals(marshall('ay', [bytes]))
    );
  });

  it('accepts a Uint8Array', () => {
    assert.ok(
      marshall('ay', [new Uint8Array(bytes)]).equals(marshall('ay', [bytes]))
    );
  });

  it('honours a TypedArray view offset', () => {
    const backing = new Uint8Array([9, 9, ...bytes, 9]);
    const view = backing.subarray(2, 2 + bytes.length);
    assert.ok(marshall('ay', [view]).equals(marshall('ay', [bytes])));
  });

  it('round-trips an empty byte array', () => {
    const buf = marshall('ay', [Buffer.alloc(0)]);
    assert.deepStrictEqual(unmarshall(buf, 'ay'), [Buffer.alloc(0)]);
  });

  it('round-trips a large byte array', () => {
    const payload = Buffer.alloc(100000);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const [out] = unmarshall(marshall('ay', [payload]), 'ay');
    assert.ok(out.equals(payload));
  });

  it('still validates the elements of a plain array', () => {
    assert.throws(() => marshall('ay', [[1, 2, 300]]), /Number outside range/);
    assert.throws(() => marshall('ay', [[1, 'x']]), /was not of type number/);
  });
});

describe('unmarshall: ay buffer ownership', () => {
  const message = require('../lib/message');

  // A small ay carried in a large message used to be returned as a view, so
  // holding four bytes kept the whole message reachable.
  const wire = message.marshall({
    serial: 1,
    type: 1,
    path: '/p',
    destination: 'a.b',
    interface: 'a.b',
    member: 'M',
    signature: 'ayay',
    body: [Buffer.alloc(512 * 1024, 7), Buffer.from([1, 2, 3, 4])]
  });

  it('does not retain the message buffer by default', () => {
    const small = message.unmarshall(wire, {}).body[1];
    assert.strictEqual(small.length, 4);
    assert.notStrictEqual(
      small.buffer,
      wire.buffer,
      'byte array still aliases the message'
    );
    assert.ok(
      small.buffer.byteLength < wire.length,
      `retained ${small.buffer.byteLength} bytes for 4 bytes of data`
    );
  });

  it("returns a zero-copy view when ayBuffer is 'view'", () => {
    const small = message.unmarshall(wire, { ayBuffer: 'view' }).body[1];
    assert.strictEqual(small.buffer, wire.buffer);
  });

  it('produces identical bytes either way', () => {
    const copied = message.unmarshall(wire, {}).body[0];
    const viewed = message.unmarshall(wire, { ayBuffer: 'view' }).body[0];
    assert.ok(copied.equals(viewed));
    assert.strictEqual(copied.length, 512 * 1024);
  });

  it('still returns a plain array when ayBuffer is false', () => {
    const small = message.unmarshall(wire, { ayBuffer: false }).body[1];
    assert.ok(Array.isArray(small));
    assert.deepStrictEqual(small, [1, 2, 3, 4]);
  });

  it('handles an empty ay in both modes', () => {
    const empty = marshall('ay', [Buffer.alloc(0)]);
    assert.strictEqual(unmarshall(empty, 'ay', 0, {})[0].length, 0);
    assert.strictEqual(
      unmarshall(empty, 'ay', 0, { ayBuffer: 'view' })[0].length,
      0
    );
  });
});

describe('marshall: array arguments', () => {
  // The old marshaller iterated `data.length` blindly, so a non-array silently
  // serialised as an empty array instead of raising.
  it('rejects a non-array where an array is expected', () => {
    assert.throws(() => marshall('ai', [5]), /Expected an array/);
    assert.throws(() => marshall('as', [true]), /Expected an array/);
    assert.throws(() => marshall('ai', [{}]), /Expected an array/);
  });

  it('still accepts array-likes', () => {
    const arrayLike = { length: 3, 0: 1, 1: 2, 2: 3 };
    assert.ok(marshall('ai', [arrayLike]).equals(marshall('ai', [[1, 2, 3]])));
  });
});

describe('marshall: alignment at a non-zero base offset', () => {
  // The header fields array is marshalled at offset 12, so alignment has to be
  // computed against the position within the message, not within the buffer.
  for (const offset of [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 13]) {
    it(`pads correctly and zero-fills at offset ${offset}`, () => {
      // 'y' then 'x' forces up to 7 bytes of padding before the 64-bit value.
      const buf = marshall('yx', [1, 2], offset);
      const padStart = 1;
      const padEnd = 8 - (offset % 8) === 8 ? 8 : 8 - (offset % 8);
      for (let i = padStart; i < padEnd; i++) {
        assert.strictEqual(
          buf[i],
          0,
          `padding byte at ${i} must be zero, got ${buf[i]}`
        );
      }
      // and the value must land where the reader expects it
      assert.deepStrictEqual(unmarshall(buf, 'yx', offset), [1, 2n]);
    });
  }
});

describe('Writer', () => {
  it('grows past its initial capacity without corrupting content', () => {
    const writer = new Writer(0, 8);
    const expected = [];
    for (let i = 0; i < 1000; i++) {
      writer.byte(i & 0xff);
      expected.push(i & 0xff);
    }
    assert.deepStrictEqual([...writer.result()], expected);
  });

  it('zero-fills padding rather than exposing uninitialised memory', () => {
    // Force a grow so the backing buffer is freshly allocUnsafe'd, then align.
    const writer = new Writer(0, 8);
    writer.raw(Buffer.alloc(9, 0xff));
    writer.align(8);
    const out = writer.result();
    for (let i = 9; i < 16; i++) {
      assert.strictEqual(out[i], 0, `pad byte ${i} leaked ${out[i]}`);
    }
  });

  it('reports a length that excludes reserved bytes correctly', () => {
    const writer = new Writer(0);
    const at = writer.reserveLength();
    writer.raw(Buffer.from([1, 2, 3]));
    writer.patchLength(at, writer.pos - at - 4);
    assert.strictEqual(writer.result().readUInt32LE(0), 3);
  });
});
