function isValidBoolean(val) {
   return val === 1 || val === 0;
}
/*
   http://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-marshaling

   The following rules define a valid object path.
   Implementations must not send or accept messages with invalid object paths.
   - The path may be of any length.
   - The path must begin with an ASCII '/'
     (integer 47) character, and must consist of elements
     separated by slash characters.
   - Each element must only contain the ASCII characters "[A-Z][a-z][0-9]_"
   - No element may be the empty string.
   - Multiple '/' characters cannot occur in sequence.
   - A trailing '/' character is not allowed unless the path is the root path (a single '/' character).
*/
// the above is copy-paste from spec. I believe they meant /^(\/$)|(\/[A-Za-z0-9_]+)+$/
function isValidObjectPath(path) {
   return path.match(/^(\/$)|(\/[A-Za-z0-9_]+)+$/);
}

var DBusBuffer = require('./dbuffer.js');

module.exports = function unmarshall(buffer, signature, startPos, options) {
  if (!startPos)
    startPos = 0;
  if (signature === "")
    return new Buffer();
  var dbuff = new DBusBuffer(buffer, startPos, options);
  return dbuff.read(signature);
};
