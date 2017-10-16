const DBusBuffer = require('./dbuffer');

module.exports = function unmarshall(buffer, signature, startPos, options) {
  if (!startPos) startPos = 0;
  if (signature === '') return new Buffer();
  var dbuff = new DBusBuffer(buffer, startPos, options);
  return dbuff.read(signature);
};
