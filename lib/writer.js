// A growable output buffer with a write cursor.
//
// This replaces the `put`-style "allocate a small Buffer per value, collect
// them in an array, concat at the end" model. Everything is written straight
// into one buffer that doubles when it runs out of room, so marshalling a
// value costs no allocation at all in the common case.
//
// Alignment is relative to `base`, the offset of this buffer within the
// enclosing message, because d-bus pads every type to its natural boundary
// counted from the start of the message rather than the start of the buffer.

const DEFAULT_CAPACITY = 256;

class Writer {
  constructor(base = 0, capacity = DEFAULT_CAPACITY) {
    this.buffer = Buffer.allocUnsafe(capacity);
    this.pos = 0;
    this.base = base;
  }

  ensure(n) {
    const needed = this.pos + n;
    if (needed <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < needed) size *= 2;
    const grown = Buffer.allocUnsafe(size);
    this.buffer.copy(grown, 0, 0, this.pos);
    this.buffer = grown;
  }

  align(boundary) {
    const pad = (boundary - ((this.base + this.pos) % boundary)) % boundary;
    if (pad === 0) return;
    this.ensure(pad);
    // Padding bytes must be zero. The backing buffer is allocUnsafe, so this
    // fill is what keeps uninitialised memory off the wire.
    this.buffer.fill(0, this.pos, this.pos + pad);
    this.pos += pad;
  }

  byte(value) {
    this.ensure(1);
    this.buffer.writeUInt8(value & 0xff, this.pos);
    this.pos += 1;
  }

  int16(value) {
    this.align(2);
    this.ensure(2);
    this.buffer.writeInt16LE(value, this.pos);
    this.pos += 2;
  }

  uint16(value) {
    this.align(2);
    this.ensure(2);
    this.buffer.writeUInt16LE(value & 0xffff, this.pos);
    this.pos += 2;
  }

  int32(value) {
    this.align(4);
    this.ensure(4);
    this.buffer.writeInt32LE(value, this.pos);
    this.pos += 4;
  }

  uint32(value) {
    this.align(4);
    this.ensure(4);
    // >>> 0 keeps the 32-bit halves of a 64-bit value, which arrive as signed
    // ints, in uint32 range.
    this.buffer.writeUInt32LE(value >>> 0, this.pos);
    this.pos += 4;
  }

  /**
   * A 64-bit integer, from a `bigint`.
   *
   * These used to be written as two uint32 words taken off a Long.js object,
   * which meant every `x`/`t` value was converted into one first -- including
   * a `bigint`, which went out through a decimal string. Node writes the eight
   * bytes directly.
   */
  int64(value, unsigned) {
    this.align(8);
    this.ensure(8);
    if (unsigned) this.buffer.writeBigUInt64LE(value, this.pos);
    else this.buffer.writeBigInt64LE(value, this.pos);
    this.pos += 8;
  }

  double(value) {
    this.align(8);
    this.ensure(8);
    this.buffer.writeDoubleLE(value, this.pos);
    this.pos += 8;
  }

  // 's' and 'o': 4-byte length, utf8 bytes, NUL. Written straight into the
  // output rather than via an intermediate Buffer.from(string).
  string(value) {
    const length = Buffer.byteLength(value, 'utf8');
    this.align(4);
    this.ensure(4 + length + 1);
    this.buffer.writeUInt32LE(length, this.pos);
    this.buffer.write(value, this.pos + 4, 'utf8');
    this.buffer.writeUInt8(0, this.pos + 4 + length);
    this.pos += 4 + length + 1;
  }

  // 'g': 1-byte length, ascii bytes, NUL. No alignment.
  signature(value) {
    const length = Buffer.byteLength(value, 'ascii');
    this.ensure(1 + length + 1);
    this.buffer.writeUInt8(length, this.pos);
    this.buffer.write(value, this.pos + 1, 'ascii');
    this.buffer.writeUInt8(0, this.pos + 1 + length);
    this.pos += 1 + length + 1;
  }

  raw(chunk) {
    this.ensure(chunk.length);
    chunk.copy(this.buffer, this.pos);
    this.pos += chunk.length;
  }

  // Reserve four bytes for an array length we cannot know yet, and return the
  // position to patch once the elements have been written.
  reserveLength() {
    this.align(4);
    this.ensure(4);
    const at = this.pos;
    this.pos += 4;
    return at;
  }

  patchLength(at, value) {
    this.buffer.writeUInt32LE(value, at);
  }

  result() {
    return this.buffer.subarray(0, this.pos);
  }
}

module.exports = Writer;
