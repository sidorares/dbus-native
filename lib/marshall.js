const assert = require('assert');

const parseSignature = require('./signature');
const Marshallers = require('./marshallers');
const Writer = require('./writer');

// Element types whose array body starts on an 8-byte boundary. The padding
// between the length and the first element is not counted in the length.
const ALIGN_8 = new Set(['x', 't', 'd', '{', '(', 'r']);

const STRING_TYPES = new Set(['g', 'o', 's']);

module.exports = function marshall(signature, data, offset = 0) {
  const tree = parseSignature(signature);
  if (!Array.isArray(data) || data.length !== tree.length) {
    throw new Error(
      `message body does not match message signature. Body:${JSON.stringify(
        data
      )}, signature:${signature}`
    );
  }
  const writer = new Writer(offset);
  writeStruct(writer, tree, data);
  return writer.result();
};

// TODO: serialise JS objects as a{sv}

function writeStruct(writer, tree, data) {
  if (tree.length !== data.length) {
    throw new Error('Invalid struct data');
  }
  for (let i = 0; i < tree.length; ++i) {
    write(writer, tree[i], data[i]);
  }
}

function write(writer, ele, data) {
  switch (ele.type) {
    case '(':
    case '{':
      writer.align(8);
      writeStruct(writer, ele.child, data);
      break;
    case 'a':
      writeArray(writer, ele, data);
      break;
    case 'v': {
      // TODO: allow serialisation of simple types as variants, e. g 123 -> ['u', 123], true -> ['b', 1], 'abc' -> ['s', 'abc']
      assert.equal(data.length, 2, 'variant data should be [signature, data]');
      writeSimple(writer, 'g', data[0]);
      const tree = parseSignature(data[0]);
      assert(tree.length === 1);
      write(writer, tree[0], data[1]);
      break;
    }
    default:
      writeSimple(writer, ele.type, data);
  }
}

function writeArray(writer, ele, data) {
  const child = ele.child[0];

  // The length counts the body only, so it is written first and patched once
  // we know how far the elements reached.
  const lengthPos = writer.reserveLength();
  if (ALIGN_8.has(child.type)) writer.align(8);
  const start = writer.pos;

  if (child.type === 'y' && ArrayBuffer.isView(data)) {
    // Fast path: a byte array backed by a Buffer or TypedArray is already the
    // wire representation, so copy it in one go. Walking it element by element
    // costs an allocation per byte and is thousands of times slower.
    writer.raw(
      Buffer.isBuffer(data)
        ? data
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    );
  } else {
    if (!Array.isArray(data) && typeof data?.length !== 'number') {
      throw new Error(
        `Expected an array for signature 'a${child.type}', got ${JSON.stringify(data)}`
      );
    }
    for (let i = 0; i < data.length; ++i) write(writer, child, data[i]);
  }

  writer.patchLength(lengthPos, writer.pos - start);
}

function writeSimple(writer, type, data) {
  if (typeof data === 'undefined')
    throw new Error(
      "Serialisation of JS 'undefined' type is not supported by d-bus"
    );
  if (data === null)
    throw new Error('Serialisation of null value is not supported by d-bus');

  if (Buffer.isBuffer(data)) data = data.toString(); // encoding?
  if (STRING_TYPES.has(type) && typeof data !== 'string') {
    throw new Error(
      `Expected string or buffer argument, got ${JSON.stringify(
        data
      )} of type '${type}'`
    );
  }

  const marshaller = Marshallers.MakeSimpleMarshaller(type);
  // check() returns a value only for the 64-bit types, which convert to Long.
  const checked = marshaller.check(data);
  marshaller.marshall(writer, checked === undefined ? data : checked);
}
