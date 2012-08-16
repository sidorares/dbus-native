var Binary = require('binary')

var handshake = require('./handshake');
var messages = require('./messages');

module.exports = function (dbus, opts) {
    var bs = Binary(dbus.stream);
    handshake.call(bs, dbus, opts);
    messages.call(bs, dbus, opts);
};
