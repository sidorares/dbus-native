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

  // debug: re-enable when dealing with OOB errors
  //if (this.pos >= this.buffer.length) {
  //  console.log(require('./hexy').hexy(this.buffer, {prefix: 'bad pos '}))
  //}
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

DBusBuffer.prototype.readString = function(len) {
  var res = this.buffer.toString('utf8', this.pos, this.pos + len);
  this.pos += len + 1; // dbus strings are always zero-terminated ('s' and 'g' types)
  return res;
}

DBusBuffer.prototype.readTree = function readTree(tree) {
  switch (tree.type) {
  case '(':
  case '{':
    this.align(3);
    return this.readStruct(tree.child);
  case 'a':
    if (!tree.child || tree.child.length != 1)
      throw new Error('Incorrect array element signature');
    var arrayBlobLength = this.readInt32();
    // is initial aligh part of arraySize?
    //if (['x', 't', 'd', '{', '('].indexOf(tree.child[0].type) != -1)
    //  this.align(3);
    return this.readArray(tree.child[0], arrayBlobLength);
    case 'v':
      return this.readVariant();
    default:
      return this.readSimpleType(tree.type);
  }
}

var parseSignature = require('./signature.js');

DBusBuffer.prototype.read = function read(signature) {
  var tree = parseSignature(signature);
  return this.readStruct(tree);
}

DBusBuffer.prototype.readVariant = function readVariant() {
  var signature = this.readSimpleType('g');
  return this.read(signature);
}

DBusBuffer.prototype.readStruct = function readStruct(struct) {
  // TODO: special case for a{sX} - save as JSON obj

  var result = [];
  for (var i = 0; i < struct.length; ++i)
    result.push(this.readTree(struct[i]));
  return result;
}

DBusBuffer.prototype.readArray = function readArray(eleType, arrayBlobSize) {
  var start = this.pos;

  // special case: treat ay as Buffer
  if (eleType.type === 'y' && this.options.ayBuffer) {
    this.pos += arrayBlobSize;
    return this.buffer.slice(start, this.pos);
  }

  var result = [];
  while(this.pos < start + arrayBlobSize)
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
    this.pos += 8;
    throw new Error('Signed 64 bit (x) not implemented')
    return 0;
  case 't': //unsigned
    this.align(3);
    this.pos += 8;
    throw new Error('Unsigned 64 bit (t) not implemented')
    return 0; // TODO!!!!
  case 'd':
    return this.readDouble();
  default:
    throw new Error('Unsupported type:' + t);
  }
}

module.exports = DBusBuffer;
