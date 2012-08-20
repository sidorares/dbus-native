var binary = require('binary')
var handshake = require('./handshake');
var message = require('./message');

module.exports = function (dbus, opts) {
    var bs = binary(dbus.stream);
    handshake.call(bs, dbus, opts);
    message.call(bs, dbus, opts);
};
