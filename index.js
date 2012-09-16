// dbus.freedesktop.org/doc/dbus-specification.html 

var EventEmitter = require('events').EventEmitter;
var net = require('net');
require('abstractsocket')(net);

var binary =    require('binary');
var parser =    require('./lib/parser');
var constants = require('./lib/constants');
var message   = require('./lib/message');

function createStream(opts) {
  if (opts.stream)
      return opts.stream;
  var host = opts.host;
  var port = opts.port;
  var socket = opts.socket;
  var stream;
  if (socket)
    return net.createConnection(socket);
  if (port)
    return net.createConnection(port, host);
  var busAddress = opts.busAddress || process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!busAddress) throw new Error('unknown bus address');
  var familyParams = busAddress.split(':');
  var family = familyParams[0];
  var params = {};
  familyParams[1].split(',').map(function(p) { 
    var keyVal = p.split('='); 
    params[keyVal[0]] = keyVal[1]; 
  });
  switch(family.toLowerCase()) {
    case 'tcp':
       host = params.host || 'localhost';
       port = params.port;
       return net.createConnection(port, host);

    case 'unix':
       if (params.socket)
         return net.createConnection(params.socket);
       if (params.abstract) {
         return net.createConnection('\u0000' + params.abstract); 
       }
       throw new Error('not enough parameters for \'unix\' connection - you need to specify \'socket\' or \'abstract\' parameter');
    default:
       throw new Error('unknown address type');
  }
 
}

module.exports = function (opts) {
    var self = new EventEmitter();
    if (!opts) opts = {};
    var stream = self.stream = createStream(opts);
    stream.setNoDelay();

    stream.on('error', function (err) {
        self.emit('error', err);
    });
    
    stream.on('end', function () {
        self.emit('end');
        self.write = function (buf) {
            console.warn("Didn't write bytes to closed stream");
        };
    });
   
//    var hexy = require('./lib/hexy');
//    self.stream.on('data', function(data) {
//       console.error(hexy.hexy(data, {prefix: 'from dbus  '})); 
//    });

    // start parsing input stream
    parser(self, opts);    

    self.write = function (buf) {
   
        //var hexy = require('./hexy');
        //console.error(hexy.hexy(buf, {prefix: 'from client'})); 

        if (Buffer.isBuffer(buf)) {
            stream.write(buf);
        }
        else {
            stream.write(buf, 'binary');
        }
        return self;
    };
    
    self.end = function () {
        stream.end();
        return self;
    };

    // TODO this is really bad
    // use own internal queue or move to async initialisation
    self.message = function(msg) {
       if (self.state === 'connected')
           message.write.call(self, msg);
       else {
           self.once('connect', function() {
               self.state = 'connected';
               message.write.call(self, msg);
           });
       }
    };
    return self;
};

var bus = require('./lib/bus');
module.exports.createClient = function(params) {
    var conn = module.exports(params);
    return new bus(conn);
};

module.exports.systemBus = function() {
    return module.exports.createClient({socket: '/var/run/dbus/system_bus_socket'});
};

module.exports.sessionBus = function(opts) {
    return module.exports.createClient(opts);
};

module.exports.messageType = constants.messageType;
module.exports.createConnection = module.exports;

var server = require('./lib/server');
module.exports.createServer = server.createServer;
