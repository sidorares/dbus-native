var binary = require('binary');
var handshake = require('./handshake');
var message = require('./message');

module.exports = function (dbus, opts) {
    var bs = binary(dbus.stream);
    if (opts.handshake !== 'none')
        handshake.call(bs, dbus, opts);
    else {
        dbus.state = 'connected';
        dbus.emit('connect');
    }
    message.read.call(bs, dbus, opts);
};
