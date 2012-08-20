// dbus.freedesktop.org/doc/dbus-specification.html 

var EventEmitter = require('events').EventEmitter;
var net = require('net');
require('abstractsocket')(net);

var binary =    require('binary');
var parser =    require('./lib/parser');
var constants = require('./lib/constants');

function createStream(opts) {
  if (opts.stream)
      return stream;
  var host = opts.host;
  var port = opts.port;
  var stream;
  if (port)
    return net.createConnection(port, host);
  var busAddress = opts.busAddress || process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!busAddress) throw new Error('unknown bus address');
  var familyParams = busAddress.split(':');
  var family = familyParams[0];
  var params = {}
  familyParams[1].split(',').map(function(p) { 
    var keyVal = p.split('='); 
    params[keyVal[0]] = keyVal[1] 
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
    default:
       throw new Error('unknown address type');
  }
 
}

module.exports = function (opts) {
    var self = new EventEmitter;
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
   

    var hexy = require('./hexy');
    self.stream.on('data', function(data) {
       console.error(hexy.hexy(data, {prefix: 'from dbus'})); 
    });

    
    // start parsing input stream
    parser(self, opts);    

    self.write = function (buf) {
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

    var littleEndian = 108; // 'l'
    //PATH = 1
    //INTERFACE = 2
    //MEMBER = 3
    //ERROR_NAME = 4
    //REPLY_SERIAL = 5
    //DESTINATION = 6
    //SENDER = 7
    //SIGNATURE = 8

    var headerType = {
      path: 1,
      interface: 2,
      member: 3,
      errorName: 4,
      repySerial: 5,
      destination: 6,
      sender: 7,
      signature: 8
    };

    function dstring(s) {
       var padded = ((s.length+1 + 3) >> 2) << 2
       var buf = Buffer(padded + 4);
       buf.fill(0);
       buf.writeUInt32LE(s.length, 0);
       buf.write(s, 4);
       return buf;
    }

    // TODO: put dbus serialising here 
    self.message = function (msg) {
        function send() {
        var messageType = 1;
        var flags = 0;
        var protocolVersion = 1;
        var bodyLength = 0;
        var serial = 1;
        var path = '/org/freedesktop/DBus';
        var iface = 'org.freedesktop.DBus';
        var member = 'Hello'
        var destination = 'org.freedesktop.DBus';
        debugger;
        binary.put()
            .word8(littleEndian)
            .word8(messageType)
            .word8(flags)
            .word8(protocolVersion)
            .word32le(bodyLength)
            .word32le(serial)
            .word32le(0x6e) // ?? header length
            .word8(headerType.path) // type: path
            .word8(1) // (length of 'o' string)
            .put(Buffer('o')) // object path
            .word8(0)
            .put(dstring(path))
            .word8(headerType.destination) // type: iface
            .word8(1)
            .put(Buffer('s'))  // utf8 string
            .word8(0)
            .put(dstring(destination))
            .word8(headerType.interface)
            .word8(1)
            .put(Buffer('s'))  // utf8 string
            .word8(0)
            .put(dstring(iface))
            .word8(headerType.member) // type: iface
            .word8(1)
            .put(Buffer('s'))  // utf8 string
            .word8(0)
            .put(dstring(member))
            .write(self)
        ;
        }
        if (self.state == 'connected')
           send()
        else {
           self.once('connect', send);
        }
        return self;
    };
    return self;
};


module.exports.messageType = constants.messageType;
