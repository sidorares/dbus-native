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

       if (!msg.type)
          msg.type = constants.messageType.methodCall;
       msg.serial = self.serial;
       self.serial++;
       if (!msg.path)
           msg.path = '/org/freedesktop/DBus';
       if (!msg.destination)
           msg.destination = 'org.freedesktop.DBus';
       if (!msg['interface'])
           msg['interface'] = 'org.freedesktop.DBus';
       this.cookies[msg.serial] = callback;
       self.connection.message(msg);
    };

    // TODO: inherit?
    this.signals = new EventEmitter();
    this.on = function(sig, cb) {
        return this.signals.on(sig, cb);
    };

    this.connection.on('message', function(msg) {
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
              };
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

    function toDBusArg(param)
    {
        if (typeof(param) === 'string')
           return { signature: 's', value: param };
        if (typeof(param) === 'number')
           return { signature: 'u', value: param };
        else throw new Error('Unknown argument');
    }

    function createDBusProxy(obj, ifaceName)
    {
        var bus = obj.service.bus;
        var service = obj.service;
        return Proxy.create({
            get: function(proxy, name) {
                return function() {
                    var args = Array.prototype.slice.apply(arguments);
                    var callback = args[args.length - 1];
                    var signature = '';
                    var msgArgs = [];
                    for (var i=0; i < args.length - 1; ++i)
                    {
                        var dbusArg = toDBusArg(args[i]);
                        signature += dbusArg.signature;
                        msgArgs.push(dbusArg.value);
                    }
                    var msg = {
                        type: constants.messageType.methodCall,
                        destination: service.name,
                        path: obj.name,
                        'interface': ifaceName,
                        member: name
                    };
                    if (signature !== '') {
                        msg.body = msgArgs;
                        msg.signature = signature;
                    }
                    return bus.invoke.call(bus, msg, callback);
                };  
            }
        }); 
    }

    function DBusObject(name, service) {
        this.name = name;
        this.service = service;
        this.as = function(name) {
            return createDBusProxy(this, name);
        };
    }

    function DBusService(name, bus) {
        this.name = name;
        this.bus = bus;
        this.getObject = function(name) {
            return new DBusObject(name, this);
        };
    }

    this.getService = function(name) {
        return new DBusService(name, this);
    };

    this.getObject = function(path, name) {
       var service = this.getService(path);
       return service.getObject(name);
    };

    this.getInterface = function(path, objname, name) {
       return this.getObject(path, objname).as(name);
    };
};
