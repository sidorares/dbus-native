const DBusBuffer = require('./dbus-buffer');

module.exports = function unmarshall(buffer, signature, startPos, options) {
  if (!startPos) startPos = 0;
  // An empty signature carries no values, so the result is an empty list of
  // them -- the same shape every other signature returns.
  if (signature === '') return [];
  const dbuff = new DBusBuffer(buffer, startPos, options);
  return dbuff.read(signature);
};
