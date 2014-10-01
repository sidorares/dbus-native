var assert = require('assert');

var parseSignature = require('./signature');
var put = require('put');

var marshall = module.exports = function(signature, data, offset) {
  if (typeof(offset) == 'undefined') offset = 0;
  var tree = parseSignature(signature);
  if (!Array.isArray(data) || data.length !== tree.length) {
    //console.log([tree, data]);
    throw new Error('message body does not match message signature. Body:' + JSON.stringify(data) + ", signature:" + signature);
  }
  var putstream = put();
  putstream._offset = offset;
  var buf = writeStruct(putstream, tree, data).buffer();
  //console.log(buf, buf.toString('hex'));
  return buf;
};

// TODO: serialise JS objects as a{sv}
//function writeHash(ps, treeKey, treeVal, data) {
//
//}

function writeStruct(ps, tree, data) {
  if (tree.length !== data.length) {
    throw new Error("Invalid struct data");
  }
  for (var i = 0; i < tree.length; ++i) {
    write(ps, tree[i], data[i]);
  }
  return ps;
}

function write(ps, ele, data) {
  switch (ele.type) {
    case '(':
    case '{':
      align(ps, 8);
      //writeHash(ps, ele.child[0], ele.child[1], data);
      writeStruct(ps, ele.child, data);
      break;
    case 'a':

      // array serialisation:
      // length of array body aligned at 4 byte boundary
      // (optional 4 bytes to align first body element on 8-byte boundary if element
      // body
      var arrPut = put();
      arrPut._offset = ps._offset;
      var _offset = arrPut._offset;
      writeSimple(arrPut, 'u', 0); // array length placeholder
      var lengthOffset = arrPut._offset - 4 - _offset;
      // we need to alighn here because alignment is not included in array length
      if (['x', 't', 'd', '{', '('].indexOf(ele.child[0].type) !== -1) align(arrPut, 8);
      var startOffset = arrPut._offset;
      for (var i = 0; i < data.length; ++i)
      write(arrPut, ele.child[0], data[i]);
      var arrBuff = arrPut.buffer();
      var length = arrPut._offset - startOffset;
      // lengthOffset in the range 0 to 3 depending on number of align bytes padded _before_ arrayLength
      arrBuff.writeUInt32LE(length, lengthOffset);
      ps.put(arrBuff);
      ps._offset += arrBuff.length;

      //console.log('=========================');
      //console.error(require('./hexy').hexy(arrBuff, {prefix: '======= '}));
      //console.log('=========================');
      break;
    case 'v':
      // TODO: allow serialisation of simple types as variants, e. g 123 -> ['u', 123], true -> ['b', 1], 'abc' -> ['s', 'abc']
      assert.equal(data.length, 2, "variant data should be [signature, data]");
      var signatureEle = {
        type: 'g',
        child: []
      };
      write(ps, signatureEle, data[0]);
      if (data[0].length == 1) {
        var variantEle = {
          type: data[0],
          child: []
        };
        write(ps, variantEle, data[1]);
      } else {
        var tree = parseSignature(data[0]);
        writeStruct(ps, tree, data[1]);
      }
      break;
    default:
      return writeSimple(ps, ele.type, data);
  }
}

function align(ps, n) {
  var pad = n - ps._offset % n;
  if (pad === 0 || pad === n) return;
  // TODO: write8(0) in a loop (3 to 7 times here) could be more efficient
  var padBuff = Buffer(pad);
  padBuff.fill(0);
  ps.put(Buffer(padBuff));
  ps._offset += pad;
}

var intTypes = ['y', 'n', 'q', 'i', 'u', 'x', 't'];
var stringTypes = ['g', 'o', 's'];

function writeSimple(ps, type, data) {
  if (typeof(data) === 'undefined') throw new Error('Serialisation of JS \'undefined\' type is not supported by d-bus');
  if (data === null) throw new Error('Serialisation of null value is not supported by d-bus');

  if (Buffer.isBuffer(data)) data = buffer.toString(); // encoding?
  if (stringTypes.indexOf(type) != -1 && typeof(data) !== 'string') throw new Error('Expected string or buffer argument');

  var buff;
  // TODO: this could be actually a bad thing
  if (intTypes.indexOf(type) != -1) data = parseInt(data, 10);

  switch (type) {
    case 'y':
      // byte
      ps.word8(data);
      ps._offset++;
      break;
    case 'n':
      // 16 bit signed bit
      align(ps, 2);
      buff = new Buffer(4);
      buff.writeInt16LE(parseInt(data), 0);
      ps.put(buff);
      ps._offset += 2;
      break;
    case 'q':
      // 16 bit unsigned int
      align(ps, 2);
      ps.word16le(data);
      ps._offset += 2;
      break;
    case 'b':
      // booleans serialised as 0/1 unsigned 32 bit int
      // TODO: require boolean type? Require input to be exactly 0/1?
      if (data) data = 1;
      else data = 0;
    case 'u':
      // 32 bit unsigned int
      align(ps, 4);
      ps.word32le(data);
      ps._offset += 4;
      break;
    case 'i':
      align(ps, 4);
      buff = new Buffer(4);
      buff.writeInt32LE(parseInt(data), 0);
      ps.put(buff);
      ps._offset += 4;
      break;
    case 'g':
      // signature
      buff = new Buffer(data, 'ascii');
      ps.word8(data.length).put(buff).word8(0);
      ps._offset += 2 + buff.length;
      break;
    case 'o':
      // object path
      // TODO: verify object path here?
    case 's':
      // utf8 string
      align(ps, 4);
      buff = new Buffer(data, 'utf8');
      ps.word32le(buff.length).put(buff).word8(0);
      ps._offset += 5 + buff.length;
      break;
    case 'x':
      align(ps, 8);
      // TODO: replace with signed word64!
      ps.word64le(data);
      ps._offset += 8;
      break;
    case 't':
      align(ps, 8);
      ps.word64le(data);
      ps._offset += 8;
      break;
    case 'd':
      align(ps, 8);
      buff = new Buffer(8);
      buff.writeDoubleLE(parseFloat(data), 0);
      ps.put(buff);
      ps._offset += 8;
      break;
    default:
      throw new Error('Unknown data type format: ' + type);
  }
  return ps;
}
