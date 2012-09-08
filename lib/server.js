var dbus = require('../index.js');
var EventEmitter = require('events').EventEmitter;
var net = require('net');

module.exports.createServer = function(handler) {
    function Server() {
        this.server = net.createServer(function(socket) {

           //var hexy = require('./hexy');
           //socket.on('data', function(data) {
           //  console.error(hexy.hexy(data, {prefix: 'from client  '}));
           //});

           var dbusConn = dbus({ stream: socket, handshake: "none" });
           dbusConn.state = 'connected';
           if (handler) 
               handler(dbusConn);
           // TODO: inherit from EE this.emit('connect', dbusConn);
        });
        this.listen = this.server.listen.bind(this.server);
    };
    return new Server();
}


