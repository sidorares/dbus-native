// Minimal in-repo replacement for the abandoned `put` package (last published
// 2012, built on the deprecated `new Buffer()` API).
//
// Only the handful of methods the marshaller actually uses are implemented:
// chainable word8/word16le/word32le/put writers plus buffer() to flatten.
//
// Callers are responsible for maintaining `_offset` (the offset of this buffer
// within the enclosing message), exactly as they were with `put`.

class Put {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  put(buffer) {
    this.chunks.push(buffer);
    this.length += buffer.length;
    return this;
  }

  word8(value) {
    const buffer = Buffer.alloc(1);
    buffer.writeUInt8(value & 0xff, 0);
    return this.put(buffer);
  }

  word16le(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value & 0xffff, 0);
    return this.put(buffer);
  }

  word32le(value) {
    const buffer = Buffer.alloc(4);
    // >>> 0 keeps negative/oversized JS numbers in uint32 range, matching the
    // wrap-around behaviour of the original `put`.
    buffer.writeUInt32LE(value >>> 0, 0);
    return this.put(buffer);
  }

  buffer() {
    return Buffer.concat(this.chunks, this.length);
  }
}

module.exports = function put() {
  return new Put();
};
