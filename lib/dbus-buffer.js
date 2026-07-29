const Long = require('long');
const constants = require('./constants');
const parseSignature = require('./signature');
const { VARIANT, DICT, tag } = require('./values');

const DEFAULT_OPTIONS = {
  ayBuffer: true,
  ReturnLongjs: false,
  returnBigInt: false,
  plainValues: false
};

// Dict key types that survive becoming JavaScript object keys.
//
// A JS object key is always a string, so `a{us}` read as an object turns the
// key 1 into '1', and with returnBigInt a 64-bit key would stringify and lose
// precision on the way back. Those dicts stay as pairs even under
// `plainValues`: converting them would be quiet corruption rather than a
// convenience, and `toPlain()` is there for anyone who wants it anyway.
const STRING_KEYS = new Set(['s', 'o', 'g']);

// Buffer + position + global start position ( used in alignment )
//
// `endianness` is the byte order the message declared in its first header
// byte. Senders may choose either, and receivers have to cope with both, so
// every multi-byte read below picks its accessor from it. Defaults to
// little-endian, which is what this library emits and what essentially every
// mainstream peer sends.
function DBusBuffer(buffer, startPos, options, endianness) {
  // `typeof null === 'object'`, so a null options argument has to be caught
  // by the truthiness check rather than the typeof.
  this.options =
    options && typeof options === 'object' ? options : DEFAULT_OPTIONS;
  // Resolved onto the instance rather than written back into `options`. A
  // connection passes its own options object straight through to every
  // message, and defaulting in place would silently add an `ayBuffer`
  // property the caller never set.
  this.ayBuffer =
    this.options.ayBuffer === undefined ? true : this.options.ayBuffer;
  // The 2.0 value shapes, available now so code can be migrated on a released
  // version rather than on a flag day. See RELEASE_PLAN.md.
  this.plainValues = this.options.plainValues === true;
  this.buffer = buffer;
  this.startPos = startPos ? startPos : 0;
  this.pos = 0;
  this.le = endianness === undefined || endianness === constants.endianness.le;
}

DBusBuffer.prototype.align = function (power) {
  const allbits = (1 << power) - 1;
  const paddedOffset = ((this.pos + this.startPos + allbits) >> power) << power;
  this.pos = paddedOffset - this.startPos;
};

DBusBuffer.prototype.readInt8 = function () {
  this.pos++;
  return this.buffer[this.pos - 1];
};

DBusBuffer.prototype.readSInt16 = function () {
  this.align(1);
  const res = this.le
    ? this.buffer.readInt16LE(this.pos)
    : this.buffer.readInt16BE(this.pos);
  this.pos += 2;
  return res;
};

DBusBuffer.prototype.readInt16 = function () {
  this.align(1);
  const res = this.le
    ? this.buffer.readUInt16LE(this.pos)
    : this.buffer.readUInt16BE(this.pos);
  this.pos += 2;
  return res;
};

DBusBuffer.prototype.readSInt32 = function () {
  this.align(2);
  const res = this.le
    ? this.buffer.readInt32LE(this.pos)
    : this.buffer.readInt32BE(this.pos);
  this.pos += 4;
  return res;
};

DBusBuffer.prototype.readInt32 = function () {
  this.align(2);
  const res = this.le
    ? this.buffer.readUInt32LE(this.pos)
    : this.buffer.readUInt32BE(this.pos);
  this.pos += 4;
  return res;
};

DBusBuffer.prototype.readDouble = function () {
  this.align(3);
  const res = this.le
    ? this.buffer.readDoubleLE(this.pos)
    : this.buffer.readDoubleBE(this.pos);
  this.pos += 8;
  return res;
};

DBusBuffer.prototype.readString = function (len) {
  // dbus strings are always zero-terminated ('s', 'o' and 'g' types), so a
  // string of `len` bytes occupies len + 1.
  if (this.pos + len + 1 > this.buffer.length) {
    throw new Error(
      `Declared string length ${len} runs past the end of the message (${this.buffer.length - this.pos} bytes left)`
    );
  }
  if (len === 0) {
    this.pos++;
    return '';
  }
  // Without this check buffer.toString() would silently clamp to the end of
  // the buffer and hand back a truncated string.
  const res = this.buffer.toString('utf8', this.pos, this.pos + len);
  this.pos += len + 1;
  return res;
};

DBusBuffer.prototype.readTree = function readTree(tree) {
  switch (tree.type) {
    case '(':
    case '{':
    case 'r':
      this.align(3);
      return this.readStruct(tree.child);
    case 'a': {
      if (!tree.child || tree.child.length !== 1)
        throw new Error('Incorrect array element signature');
      const arrayBlobLength = this.readInt32();
      return this.readArray(tree.child[0], arrayBlobLength);
    }
    case 'v':
      return this.readVariant();
    default:
      return this.readSimpleType(tree.type);
  }
};

DBusBuffer.prototype.read = function read(signature) {
  const tree = parseSignature(signature);
  return this.readStruct(tree);
};

DBusBuffer.prototype.readVariant = function readVariant() {
  const signature = this.readSimpleType('g');
  const tree = parseSignature(signature);
  const values = this.readStruct(tree);
  // Under `plainValues` the wrapper is gone and the signature with it, which
  // is the 2.0 shape. A variant holds exactly one complete type, so the
  // length check is belt and braces -- it mirrors variantValue().
  if (this.plainValues) return values.length === 1 ? values[0] : values;
  // Tagged so variantValue()/toPlain() can recognise this without guessing
  // from shape. The tag is non-enumerable and invisible to consumers.
  return tag([tree, values], VARIANT);
};

DBusBuffer.prototype.readStruct = function readStruct(struct) {
  const result = [];
  for (let i = 0; i < struct.length; ++i) {
    result.push(this.readTree(struct[i]));
  }
  return result;
};

DBusBuffer.prototype.readArray = function readArray(eleType, arrayBlobSize) {
  const start = this.pos;

  if (arrayBlobSize > constants.maxArraySize) {
    throw new Error(
      `Declared array length ${arrayBlobSize} exceeds the maximum of ${constants.maxArraySize} bytes`
    );
  }
  if (start + arrayBlobSize > this.buffer.length) {
    throw new Error(
      `Declared array length ${arrayBlobSize} runs past the end of the message (${this.buffer.length - start} bytes left)`
    );
  }

  // special case: treat ay as Buffer
  if (eleType.type === 'y' && this.ayBuffer) {
    this.pos += arrayBlobSize;
    const bytes = this.buffer.subarray(start, this.pos);
    // A subarray shares memory with the whole message, so holding on to a
    // handful of bytes would keep the entire message alive -- a 4 byte `ay`
    // pulled out of a 4 MB message retained all 4 MB. Copy by default and let
    // callers opt back into the zero-copy view if they know the lifetimes are
    // fine. The copy runs at memcpy speed and is noise next to the I/O that
    // delivered the message in the first place.
    return this.ayBuffer === 'view' ? bytes : Buffer.from(bytes);
  }

  // end of array is start of first element + array size
  // we need to add 4 bytes if not on 8-byte boundary
  // and array element needs 8 byte alignment
  if (['x', 't', 'd', '{', '(', 'r'].indexOf(eleType.type) !== -1)
    this.align(3);
  const end = this.pos + arrayBlobSize;
  const result = [];
  while (this.pos < end) result.push(this.readTree(eleType));
  if (eleType.type !== '{') return result;

  // A dict whose keys are strings becomes a plain object under `plainValues`.
  // Duplicate keys collapse to the last one -- the spec calls a message with
  // repeated keys corrupt, and does not require a receiver to reject it.
  if (this.plainValues && STRING_KEYS.has(eleType.child[0].type)) {
    const out = {};
    for (const [key, value] of result) out[key] = value;
    return out;
  }
  // A dict is an array of dict-entry structs. Tagging it here is what lets
  // toPlain() tell `a{ss}` from `a(ss)`, which are otherwise identical.
  return tag(result, DICT);
};

// A 64-bit value is two 32-bit words. Each word is byte-swapped by readInt32
// according to the message's byte order, and the *order of the words* flips
// too: little-endian puts the low word first, big-endian the high word.
DBusBuffer.prototype.readLong = function readLong(unsigned) {
  this.align(3);
  const first = this.readInt32();
  const second = this.readInt32();
  return this.le
    ? Long.fromBits(first, second, unsigned)
    : Long.fromBits(second, first, unsigned);
};

// The same 64 bits as readLong, as a native BigInt.
//
// Read straight from the buffer rather than composing two 32-bit words: Node
// has accessors for exactly this, and going through readInt32 twice would mean
// reassembling a value the platform can already produce exactly.
DBusBuffer.prototype.readBigInt = function readBigInt(unsigned) {
  this.align(3);
  const buf = this.buffer;
  const at = this.pos;
  this.pos += 8;
  if (unsigned) {
    return this.le ? buf.readBigUInt64LE(at) : buf.readBigUInt64BE(at);
  }
  return this.le ? buf.readBigInt64LE(at) : buf.readBigInt64BE(at);
};

DBusBuffer.prototype.readSimpleType = function readSimpleType(t) {
  let len;
  switch (t) {
    case 'y':
      return this.readInt8();
    case 'b':
      // TODO: spec says that true is strictly 1 and false is strictly 0
      // should we error (or warn?) when non 01 values?
      return this.readInt32() ? true : false;
    case 'n':
      return this.readSInt16();
    case 'q':
      return this.readInt16();
    case 'u':
      return this.readInt32();
    case 'i':
      return this.readSInt32();
    case 'g':
      len = this.readInt8();
      return this.readString(len);
    case 's':
    case 'o':
      len = this.readInt32();
      return this.readString(len);
    // An incoming object path is deliberately not validated, though what we
    // send is (see lib/names.js). The spec only requires a receiver to be
    // able to reject one, a malformed path is not a memory-safety problem --
    // readString already bounds-checks -- and refusing one would break
    // interop with a sloppy peer over a name we can pass through harmlessly.
    // 64-bit. `returnBigInt` is the forward-compatible option and wins over
    // `ReturnLongjs` when both are set: BigInt is what these become in 2.0,
    // and silently preferring the deprecated one would be the wrong default
    // for someone who has asked for both while migrating.
    case 'x':
      //signed
      if (this.options.returnBigInt) return this.readBigInt(false);
      // Long.js is only built when the deprecated option asks for one. The
      // default used to construct one and immediately call toNumber(), which
      // is the same lossy conversion with a dependency in the middle.
      if (this.options.ReturnLongjs) return this.readLong(false);
      return Number(this.readBigInt(false)); // good up to 53 bits
    case 't':
      //unsigned
      if (this.options.returnBigInt) return this.readBigInt(true);
      if (this.options.ReturnLongjs) return this.readLong(true);
      return Number(this.readBigInt(true)); // good up to 53 bits
    case 'd':
      return this.readDouble();
    default:
      throw new Error(constants.unsupportedType(t, 'read'));
  }
};

module.exports = DBusBuffer;
