const marshall = require('./marshall');
const constants = require('./constants');
const DBusBuffer = require('./dbus-buffer');

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
  onError
) {
  const maxMessageSize =
    (opts && opts.maxMessageSize) || constants.maxMessageSize;

  let state = 0; // 0: header, 1: fields + body
  let header, fieldsAndBody;
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

    if (header[0] !== constants.endianness.le) {
      // Big-endian senders are legal but unimplemented. Fail loudly rather
      // than reading the whole message little-endian and yielding garbage.
      throw new ProtocolError(
        `Unsupported byte order '${String.fromCharCode(header[0])}'. Only little-endian ('l') messages can be read.`
      );
    }

    bodyLength = header.readUInt32LE(4);
    fieldsLength = header.readUInt32LE(12);

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

    const messageBuffer = new DBusBuffer(fieldsAndBody, undefined, opts);
    const unmarshalledHeader = messageBuffer.readArray(
      headerSignature[0].child[0],
      fieldsLength
    );
    messageBuffer.align(3);
    const message = {};
    message.serial = header.readUInt32LE(8);

    for (const field of unmarshalledHeader) {
      const headerName = constants.headerTypeName[field[0]];
      message[headerName] = field[1][1][0];
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
      // Dispatch outside the try: a throw from application code is not a
      // framing error and must not be reported as one.
      onMessage(message);
    }
  }

  stream.on('readable', onReadable);
};

// given buffer which contains entire message deserialise it
// TODO: factor out common code
module.exports.unmarshall = function unmarshall(buff, opts) {
  const msgBuf = new DBusBuffer(buff, undefined, opts);
  const headers = msgBuf.read('yyyyuua(yv)');
  const message = {};
  for (let i = 0; i < headers[6].length; ++i) {
    const headerName = constants.headerTypeName[headers[6][i][0]];
    message[headerName] = headers[6][i][1][1][0];
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
