var unmarshall = require('./unmarshall.js');
var marshall   = require('./marshall.js');
var constants  = require('./constants.js');
var signature  = require('./signature.js');
var DBusBuffer = require('./dbuffer.js');

var headerSignature = require('./header-signature.json');

module.exports.unmarshalMessages = function messageParser(stream, onMessage) {
  var state = 0; // 0: header, 1: fields + body
  var header, fieldsAndBody;
  var fieldsLength, fieldsLengthPadded;
  var fieldsAndBodyLength = 0;
  var bodyLength = 0;
  stream.on('readable', function() {

    var header;
    while (1) {
      if (state == 0) {
        header = stream.read(16);
        if (!header) break;
        fieldsLength = header.readUInt32LE(12);
        fieldsLengthPadded = ((fieldsLength + 3) >> 3) << 3;
        bodyLength = header.readUInt32LE(4);
        fieldsAndBodyLength = fieldsLengthPadded + bodyLength;
        state = 1;
      } else {

        fieldsAndBody = stream.read(fieldsAndBodyLength);
        if (!fieldsAndBody) break;

        var messageBuffer = new DBusBuffer(fieldsAndBody);
        var unmarshalledHeader = messageBuffer.readArray(headerSignature[0].child[0], fieldsLength);
        messageBuffer.align(3);
        var headerName;
        var message = {};
        message.serial = header.readUInt32LE(8)

        for (var i = 0; i < unmarshalledHeader.length; ++i) {
          headerName = constants.headerTypeName[unmarshalledHeader[i][0]];
          message[headerName] = unmarshalledHeader[i][1][0];
        }
        message.type = header[1];

        if (bodyLength > 0 && message.signature)
          message.body = messageBuffer.readStruct(signature(message.signature));
        state = 0;

        onMessage(message);
      }
    }
  });
};

module.exports.marshall = function marshallMessage(message) {
  if (!message.serial) message.serial = 1;
  var flags = message.flags || 0;
  var type = message.type || constants.messageType.methodCall;
  var bodyLength = 0;
  var bodyBuff;
  if (message.body) {
    bodyBuff = marshall(message.signature, message.body);
    bodyLength = bodyBuff.length;
  }
  var header = [constants.endianness.le, type, flags, constants.protocolVersion, bodyLength, message.serial];
  var headerBuff = marshall('yyyyuu', header);
  var fields = [];
  constants.headerTypeName.forEach(function(fieldName) {
    var fieldVal = message[fieldName];
    if (fieldVal) {
      fields.push([constants.headerTypeId[fieldName],
        [constants.fieldSignature[fieldName], fieldVal]
      ]);
    }
  });
  var fieldsBuff = marshall('a(yv)', [fields], 12);
  var headerLenAligned = ((headerBuff.length + fieldsBuff.length + 7) >> 3) << 3;
  var messageLen = headerLenAligned + bodyLength;
  var messageBuff = Buffer(messageLen);
  messageBuff.fill(0);
  headerBuff.copy(messageBuff);
  fieldsBuff.copy(messageBuff, headerBuff.length);
  if (bodyLength > 0) bodyBuff.copy(messageBuff, headerLenAligned);

  return messageBuff;
};
