var dbus = require('../index.js');
var EventEmitter = require('events').EventEmitter;
var net = require('net');

module.exports.createServer = function(handler) {
    function Server() {
        var id = 123;
        this.server = net.createServer(function(socket) {

           //var hexy = require('./hexy');
           //socket.on('data', function(data) {
           //  console.error(hexy.hexy(data, {prefix: 'from client  '}));
           //});

           socket.idd = id;
           id++;

           var dbusConn = dbus({ stream: socket, server: true });
           //dbusConn.state = 'connected';
           if (handler)
               handler(dbusConn);
           // TODO: inherit from EE this.emit('connect', dbusConn);
        });
        this.listen = this.server.listen.bind(this.server);
    };
    return new Server();
}


