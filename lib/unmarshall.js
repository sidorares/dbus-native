const Buffer = require('safe-buffer').Buffer;
const DBusBuffer = require('./dbuffer');

module.exports = function unmarshall(buffer, signature, startPos, options) {
  if (!startPos) startPos = 0;
  if (signature === '') return Buffer.from('');
  var dbuff = new DBusBuffer(buffer, startPos, options);
  return dbuff.read(signature);
};
