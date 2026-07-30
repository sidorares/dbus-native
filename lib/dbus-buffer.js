const constants = require('./constants');
const parseSignature = require('./signature');
const { VARIANT, DICT, tag, Variant } = require('./values');

const DEFAULT_OPTIONS = {
  ayBuffer: true,
  returnBigInt: true,
  plainValues: true
};

// How a `v` comes back.
//
//   'tree'  [parsedSignatureTree, [value]] -- what 1.x hands back
//   'plain' the value, and the signature is gone
//   'wrap'  a Variant, carrying both
//
// 'wrap' exists because 'plain' throws the type away and nothing downstream
// can put it back: `dbus-native call` prints `variant u 501` and a service
// receiving a{sv} may need to know what its caller sent. Both used to need the
// tree, which meant reading the parser's internals to get at a signature.
//
// A Variant does that job better -- it prints readably, `variantValue()` and
// `toPlain()` already understand it, and the marshaller already accepts it, so
// a value read in this shape can be sent straight back out. See
// BIG_FUTURE_PLANS 2.1.
const VARIANT_SHAPES = new Set(['tree', 'plain', 'wrap']);

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
  //
  // `plainValues` governs dicts; `variants` governs variants and defaults to
  // whatever `plainValues` implied, so it is purely additive. Separating them
  // is what lets a caller take the plain dicts and keep the type information
  // on the values inside them, which is the combination both the CLI and a
  // service inspecting a{sv} actually want.
  this.plainValues = this.options.plainValues !== false;
  this.returnBigInt = this.options.returnBigInt !== false;
  const variants = this.options.variants;
  if (variants !== undefined && !VARIANT_SHAPES.has(variants)) {
    throw new TypeError(
      `Unknown 'variants' option ${JSON.stringify(variants)}; expected 'tree', 'plain' or 'wrap'`
    );
  }
  this.variants =
    variants === undefined ? (this.plainValues ? 'plain' : 'tree') : variants;
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
  // A variant holds exactly one complete type, so the length check is belt and
  // braces -- it mirrors variantValue().
  const value = values.length === 1 ? values[0] : values;
  // The signature is the one the sender wrote, not one re-derived from the
  // value: `u`, `i` and `d` all arrive as a JS number, so inferring it back
  // would be a guess dressed up as type information.
  if (this.variants === 'wrap') return new Variant(signature, value);
  if (this.variants === 'plain') return value;
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

// A 64-bit value, as a native BigInt.
//
// Read straight from the buffer rather than composing two 32-bit words: Node
// has accessors for exactly this, and going through readInt32 twice would mean
// reassembling a value the platform can already produce exactly. The two-word
// version this replaced also had to flip the *order* of the words on a
// big-endian message as well as the bytes within each, which is easy to get
// half right.
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
    // UNIX_FD: an index into the message's fd array, not a descriptor. The
    // descriptors themselves are on `msg.fds`.
    case 'h':
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
    // 64-bit, exactly, unless the caller has asked for the 1.x lossiness back.
    case 'x':
      //signed
      if (this.returnBigInt) return this.readBigInt(false);
      return Number(this.readBigInt(false)); // good up to 53 bits
    case 't':
      //unsigned
      if (this.returnBigInt) return this.readBigInt(true);
      return Number(this.readBigInt(true)); // good up to 53 bits
    case 'd':
      return this.readDouble();
    default:
      throw new Error(constants.unsupportedType(t));
  }
};

module.exports = DBusBuffer;
