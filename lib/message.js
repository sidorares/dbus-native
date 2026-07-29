const marshall = require('./marshall');
const constants = require('./constants');
const DBusBuffer = require('./dbus-buffer');
const { variantValue } = require('./values');

const headerSignature = require('./header-signature.json');

const EMPTY = Buffer.alloc(0);

// Round up to the next 8-byte boundary. The obvious `((n + 7) >> 3) << 3`
// wraps to int32, so a peer declaring a length above 2^31 would produce a
// negative padded length.
function align8(n) {
  return Math.ceil(n / 8) * 8;
}

class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = 'EPROTO';
  }
}
module.exports.ProtocolError = ProtocolError;

module.exports.unmarshalMessages = function messageParser(
  stream,
  onMessage,
  opts,
  onError,
  onHandlerError
) {
  const maxMessageSize =
    (opts && opts.maxMessageSize) || constants.maxMessageSize;

  let state = 0; // 0: header, 1: fields + body
  let header, fieldsAndBody, endianness;
  let fieldsLength, fieldsLengthPadded;
  let fieldsAndBodyLength = 0;
  let bodyLength = 0;
  let failed = false;

  // A malformed message is not recoverable: we have lost framing and cannot
  // tell where the next message starts. Stop reading and report.
  function fail(err) {
    if (failed) return;
    failed = true;
    stream.removeListener('readable', onReadable);
    if (onError) onError(err);
    else stream.emit('error', err);
  }

  function readHeader() {
    header = stream.read(16);
    if (!header) return false;

    endianness = header[0];
    if (
      endianness !== constants.endianness.le &&
      endianness !== constants.endianness.be
    ) {
      throw new ProtocolError(
        `Invalid byte order '${String.fromCharCode(endianness)}' (0x${endianness.toString(16)}), expected 'l' or 'B'`
      );
    }
    // The spec requires a receiver to reject a major protocol version it does
    // not understand rather than guess at the layout.
    if (header[3] !== constants.protocolVersion) {
      throw new ProtocolError(
        `Unsupported protocol version ${header[3]}, expected ${constants.protocolVersion}`
      );
    }

    const le = endianness === constants.endianness.le;

    bodyLength = le ? header.readUInt32LE(4) : header.readUInt32BE(4);
    fieldsLength = le ? header.readUInt32LE(12) : header.readUInt32BE(12);

    // Validate before doing any arithmetic on, or allocating for, these.
    if (bodyLength > maxMessageSize || fieldsLength > maxMessageSize) {
      throw new ProtocolError(
        `Message exceeds the maximum size: header fields ${fieldsLength} bytes, body ${bodyLength} bytes, limit ${maxMessageSize} bytes`
      );
    }
    fieldsLengthPadded = align8(fieldsLength);
    fieldsAndBodyLength = fieldsLengthPadded + bodyLength;
    if (fieldsAndBodyLength + 16 > maxMessageSize) {
      throw new ProtocolError(
        `Message exceeds the maximum size: ${fieldsAndBodyLength + 16} bytes, limit ${maxMessageSize} bytes`
      );
    }
    return true;
  }

  function readBody() {
    // stream.read(0) never yields a buffer, so short-circuit the empty case
    // rather than stalling the loop on it.
    fieldsAndBody =
      fieldsAndBodyLength === 0 ? EMPTY : stream.read(fieldsAndBodyLength);
    if (!fieldsAndBody) return null;

    const messageBuffer = new DBusBuffer(
      fieldsAndBody,
      undefined,
      opts,
      endianness
    );
    const unmarshalledHeader = messageBuffer.readArray(
      headerSignature[0].child[0],
      fieldsLength
    );
    messageBuffer.align(3);
    const message = {};
    message.serial =
      endianness === constants.endianness.le
        ? header.readUInt32LE(8)
        : header.readUInt32BE(8);

    for (const field of unmarshalledHeader) {
      const headerName = constants.headerTypeName[field[0]];
      // A header field value is a variant, and this buffer was built with the
      // connection's own options -- so once a value-shape option can flip what
      // a variant looks like, `field[1][1][0]` reads the wrong thing on every
      // message. variantValue() reads either shape, and costs 0.018 us per
      // message against ~1 us to unmarshall one.
      message[headerName] = variantValue(field[1]);
    }

    message.type = header[1];
    message.flags = header[2];

    if (bodyLength > 0 && message.signature) {
      message.body = messageBuffer.read(message.signature);
    }
    return message;
  }

  function onReadable() {
    while (!failed) {
      let message;
      try {
        if (state === 0) {
          if (!readHeader()) return;
          state = 1;
          continue;
        }
        message = readBody();
        if (!message) return;
        state = 0;
      } catch (err) {
        return fail(err);
      }

      // Dispatch runs application code. An exception from it is a bug in the
      // consumer, not a framing error, so it gets its own channel -- and it
      // must not unwind through the parser, which would abandon whatever else
      // is already sitting in the read buffer.
      try {
        onMessage(message);
      } catch (err) {
        if (!onHandlerError) throw err;
        onHandlerError(err);
      }
    }
  }

  stream.on('readable', onReadable);
};

// given buffer which contains entire message deserialise it
// TODO: factor out common code
module.exports.unmarshall = function unmarshall(buff, opts) {
  // The byte order flag is the first byte and is itself order-independent, so
  // it can be read before deciding how to read everything after it.
  const endianness = buff[0];
  if (
    endianness !== constants.endianness.le &&
    endianness !== constants.endianness.be
  ) {
    throw new ProtocolError(
      `Invalid byte order '${String.fromCharCode(endianness)}' (0x${(endianness ?? 0).toString(16)}), expected 'l' or 'B'`
    );
  }
  const msgBuf = new DBusBuffer(buff, undefined, opts, endianness);
  const headers = msgBuf.read('yyyyuua(yv)');
  const message = {};
  for (let i = 0; i < headers[6].length; ++i) {
    const headerName = constants.headerTypeName[headers[6][i][0]];
    // As in the streaming path above: a header field value is a variant.
    message[headerName] = variantValue(headers[6][i][1]);
  }
  message.type = headers[1];
  message.flags = headers[2];
  message.serial = headers[5];
  msgBuf.align(3);
  // headers[4] is the declared body length. Argument-less messages (Hello,
  // Ping, ListNames, ...) carry no signature header field at all, so reading a
  // body here would parse `undefined` as a signature.
  if (headers[4] > 0 && message.signature) {
    message.body = msgBuf.read(message.signature);
  }
  return message;
};

module.exports.marshall = function marshallMessage(message) {
  if (!message.serial) throw new Error('Missing or invalid serial');
  const flags = message.flags || 0;
  const type = message.type || constants.messageType.methodCall;
  let bodyLength = 0;
  let bodyBuff;
  if (message.signature && message.body) {
    bodyBuff = marshall(message.signature, message.body);
    bodyLength = bodyBuff.length;
  }
  const header = [
    constants.endianness.le,
    type,
    flags,
    constants.protocolVersion,
    bodyLength,
    message.serial
  ];
  const headerBuff = marshall('yyyyuu', header);
  const fields = [];
  constants.headerTypeName.forEach(fieldName => {
    const fieldVal = message[fieldName];
    if (fieldVal) {
      fields.push([
        constants.headerTypeId[fieldName],
        [constants.fieldSignature[fieldName], fieldVal]
      ]);
    }
  });
  const fieldsBuff = marshall('a(yv)', [fields], 12);
  const headerLenAligned =
    ((headerBuff.length + fieldsBuff.length + 7) >> 3) << 3;
  const messageLen = headerLenAligned + bodyLength;
  const messageBuff = Buffer.alloc(messageLen);
  headerBuff.copy(messageBuff);
  fieldsBuff.copy(messageBuff, headerBuff.length);
  if (bodyLength > 0) bodyBuff.copy(messageBuff, headerLenAligned);

  return messageBuff;
};
