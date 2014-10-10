var isSimpleType = {};
'ybnquigsoxtd'.split(' ').forEach(function(t) {
  isSimpleType[t] = true;
});

// Buffer + position + global start position ( used in alignment )
function DBusBuffer(buffer, startPos, options)
{
  this.options = options || { ayBuffer: true };
  this.buffer = buffer;
  this.startPos = startPos ? startPos : 0,
  this.pos = 0;
}

DBusBuffer.prototype.align = function(power) {
  var allbits = (1<<power) - 1;
  var paddedOffset = ((this.pos + this.startPos + allbits) >> power) << power;
  this.pos = paddedOffset - this.startPos;
}

DBusBuffer.prototype.readInt8 = function() {
  this.pos++;
  return this.buffer[this.pos - 1];
}

DBusBuffer.prototype.readSInt16 = function() {
  this.align(1);
  var res = this.buffer.readInt16LE(this.pos);
  this.pos += 2;
  return res;
}

DBusBuffer.prototype.readInt16 = function() {
  this.align(1);
  var res = this.buffer.readUInt16LE(this.pos);
  this.pos += 2;
  return res;
}

DBusBuffer.prototype.readSInt32 = function() {
  this.align(2);
  var res = this.buffer.readInt32LE(this.pos);
  this.pos += 4;
  return res;
}

DBusBuffer.prototype.readInt32 = function() {
  this.align(2);
  var res = this.buffer.readUInt32LE(this.pos);
  this.pos += 4;
  return res;
}

DBusBuffer.prototype.readDouble = function() {
  this.align(3);
  var res = this.buffer.readDoubleLE(this.pos);
  this.pos += 8;
  return res;
}

DBusBuffer.prototype.readString = function(len) {
  if (len === 0) {
    this.pos++;
    return '';
  }
  var res = this.buffer.toString('utf8', this.pos, this.pos + len);
  this.pos += len + 1; // dbus strings are always zero-terminated ('s' and 'g' types)
  return res;
}

var parseSignature = require('./signature.js');

DBusBuffer.prototype.readTree = function readTree(tree) {
  switch (tree.type) {
  case '(':
  case '{':
  case 'r':
    this.align(3);
    return this.readStruct(tree.child);
  case 'a':
    if (!tree.child || tree.child.length != 1)
      throw new Error('Incorrect array element signature');
    var arrayBlobLength = this.readInt32();
    return this.readArray(tree.child[0], arrayBlobLength);
    return arr;
    case 'v':
      return this.readVariant();
    default:
      return this.readSimpleType(tree.type);
  }
}


DBusBuffer.prototype.read = function read(signature) {
  var tree = parseSignature(signature);
  return this.readStruct(tree);
}

DBusBuffer.prototype.readVariant = function readVariant() {
  var signature = this.readSimpleType('g');
  //if (isSimpleType[signature])
  //  return this.readSimpleType(signature);

  //if (signature == 'a{sv}')
  //{
  //  var arrayBlobLength = this.readInt32();
  //  return this.readArray(parseSignature(signatur
  //}
  return this.read(signature);
}

DBusBuffer.prototype.readStruct = function readStruct(struct) {
  var result = [];
  for (var i = 0; i < struct.length; ++i) {
    result.push(this.readTree(struct[i]));
  }
  return result;
}

// check if it's a{sX} s -> any type
// return value type
function isHash(t) {
  if (t.type == '{' && t.child[0].type == 's')
    return t.child[1];
  return null;
}

DBusBuffer.prototype.readArray = function readArray(eleType, arrayBlobSize) {
  var result;
  var key, value;
  var start = this.pos;

  /*
  if (isHash(eleType)) {
    result = {};
    while(this.pos < start + arrayBlobSize) {
      this.align(3);
      key = this.readTree(eleType.child[0]);
      result[key] = this.readTree(eleType.child[1]);
    }
    console.log('Hash!!!', eleType, parseSignature.fromTree(eleType), result);
    return result;
  }
  */

  // special case: treat ay as Buffer
  if (eleType.type === 'y' && this.options.ayBuffer) {
    this.pos += arrayBlobSize;
    return this.buffer.slice(start, this.pos);
  }

  // end of array is start of first element + array size
  // we need to add 4 bytes if not on 8-byte boundary
  // and array element needs 8 byte alignment
  if (['x', 't', 'd', '{', '(', 'r'].indexOf(eleType.type) != -1)
    this.align(3);
  var end = this.pos + arrayBlobSize;
  result = [];
  while(this.pos < end)
    result.push(this.readTree(eleType));
  return result;
}

DBusBuffer.prototype.readSimpleType = function readSimpleType(t) {
  switch (t) {
  case 'y':
    return this.readInt8();
  case 'b':
    // TODO: spec says that true is strictly 1 and false is strictly 0
    // shold we error (or warn?) when non 01 values?
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
    var len = this.readInt8();
    return this.readString(len);
  case 's':
  case 'o':
    var len = this.readInt32();
    return this.readString(len);
    // TODO: validate object path here
    //if (t === 'o' && !isValidObjectPath(str))
    //  throw new Error('string is not a valid object path'));
  case 'x': //signed
    this.align(3);
    // TODO: BE 0x100000000*this.readInt32() + this.readInt32();
    // TODO: use bn.js
    return this.readInt32() + 0x100000000*this.readInt32();
  case 't': //unsigned
    this.align(3);
    var word0 = this.readInt32();
    var word1 = this.readInt32();
    if (!(word1 & 0x80000000))
      return word0 + 0x100000000*word1;
    return -((((~word1)>>>0) * 0x100000000) + ((~word0)>>>0) + 1);
  case 'd':
    return this.readDouble();
  default:
    throw new Error('Unsupported type: ' + t);
  }
  return result;
}

module.exports = DBusBuffer;
