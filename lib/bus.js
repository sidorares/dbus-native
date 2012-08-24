var EventEmitter = require('events').EventEmitter;

var constants = require('./constants');
module.exports = function bus(conn) {
    if (!(this instanceof bus)) {
        return new bus(conn);
    }    

    var self = this;
    this.connection = conn;
    this.serial = 1;
    this.cookies = {};

    this.invoke = function(msg, callback) {

       console.log('CALLING INVOKE');
       
       if (!msg.type)
          msg.type = constants.messageType.methodCall;
       msg.serial = self.serial;
       self.serial++;
       if (!msg.path)
           msg.path = '/org/freedesktop/DBus';
       if (!msg.destination)
           msg.destination = 'org.freedesktop.DBus';
       if (!msg.interface)
           msg.interface = 'org.freedesktop.DBus';
       this.cookies[msg.serial] = callback;
       console.log(' === CALLING MSG === ', msg);
       self.connection.message(msg);
    }

    // TODO: inherit?
    this.signals = new EventEmitter();
    this.on = function(sig, cb) {
        return this.signals.on(sig, cb);
    }

    this.connection.on('message', function(msg) {
       // TODO: handle error replies
       //console.log('reply/error:', msg, constants.messageType);
       if (msg.type == constants.messageType.methodReturn || msg.type == constants.messageType.error) {
 
           var handler = self.cookies[msg.replySerial];
           if (msg.type == constants.messageType.methodReturn && msg.body)
              msg.body.unshift(null); // first argument - no errors, null
           if (handler) {
              delete self.cookies[msg.replySerial];
              var props = {
                 connection: self.connection,
                 bus: self,
                 signature: msg.signature
              }
              if (msg.type == constants.messageType.methodReturn)
                 handler.apply(props, msg.body); // body as array of arguments
              else
                 handler.call(props, msg.body);  // body as first argument
           }    
       } else if (msg.type == constants.messageType.signal) {
           self.signals.emit(msg.member, msg);
       }
    });

    // register name
    this.invoke({ member: 'Hello' }, function(err, name) {
       self.name = name;
    });
}
