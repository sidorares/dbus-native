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
       //if (!msg.path)
       //    msg.path = '/org/freedesktop/DBus';
       //if (!msg.destination)
       //    msg.destination = 'org.freedesktop.DBus';
       //if (!msg['interface'])
       //    msg['interface'] = 'org.freedesktop.DBus';
       this.cookies[msg.serial] = callback;
       console.log('about to send', msg);
       self.connection.message(msg);
    };

    this.invokeDbus = function(msg, callback) {
       if (!msg.path)
           msg.path = '/org/freedesktop/DBus';
       if (!msg.destination)
           msg.destination = 'org.freedesktop.DBus';
       if (!msg['interface'])
           msg['interface'] = 'org.freedesktop.DBus';    
       self.invoke(msg, callback);
    };

    // TODO: inherit?
    // this.signals = new EventEmitter();
    // this.on = function(sig, cb) {
    //    return this.signals.on(sig, cb);
    //};

    // route reply/error
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
                 message: msg,
                 signature: msg.signature
              };
              if (msg.type == constants.messageType.methodReturn)
                 handler.apply(props, msg.body); // body as array of arguments
              else
                 handler.call(props, msg.body);  // body as first argument
           }    
       } else if (msg.type == constants.messageType.signal) {
           //self.signals.emit(msg.member, msg);
       }
    });

    // register name
    this.invokeDbus({ member: 'Hello' }, function(err, name) {
       self.name = name;
    });

    this.propertyGet = function(iface, propertyName, callback) {
       
    };

    this.propertySet = function(iface, propertyName, callback) {
       
    };

    // TODO: guess dbus signature from js type
    function toDBusArg(param)
    {
        if (typeof(param) === 'string' || Buffer.isBuffer(param))
           return { signature: 's', value: param };
        if (typeof(param) === 'number')
           return { signature: 'u', value: param };
        if (typeof(param) === 'boolean')
           return { signature: 'b', value: param };
        if (Array.isArray(param))
            return { signature: 'a' + toDBusArg(param[0]).signature, value: param};
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

    // TODO: refactor

    // bus meta functions
    this.addMatch = function(match, callback) {
        this.invokeDbus({ 'member': 'AddMatch', signature: 's', body: [match] }, callback);
    }; 
   
    this.removeMatch = function(match, callback) {
        this.invokeDbus({ 'member': 'RemoveMatch', signature: 's', body: [match] }, callback);
    }; 
    
    this.getId = function(callback) {
        this.invokeDbus({ 'member': 'GetId' }, callback);
    }; 
   
    this.requestName = function(name, flags, callback) {
        this.invokeDbus({ 'member': 'RequestName', signature: 'su', body: [name, flags] }, callback);
    };

    this.releaseName = function(name, callback) {
        this.invokeDbus({ 'member': 'ReleaseName', signature: 's', body: [name] }, callback);
    };

    this.listNames = function(callback) {
       this.invokeDbus({ 'member': 'ListNames' }, callback);
    };

    this.listActivatableNames = function(callback) {
       this.invokeDbus({ 'member': 'ListActivatableNames', signature: 's', body: [name]}, callback);
    };

    this.updateActivationEnvironment = function(env, callback) {
       this.invokeDbus({ 'member': 'UpdateActivationEnvironment', signature: 'a{ss}', body: [env]}, callback);
    };

    this.startServiceByName = function(name, flags, callback) {
       this.invokeDbus({ 'member': 'StartServiceByName', signature: 'su', body: [name, flags] }, callback);
    };
    
    this.getConnectionUnixUser = function(name, callback) {
       this.invokeDbus({ 'member': 'GetConnectionUnixUser', signature: 's', body: [name]}, callback);
    };

    this.getConnectionProcessId = function(name, callback) {
       this.invokeDbus({ 'member': 'GetConnectionProcessID', signature: 's', body: [name]}, callback);
    };

    this.getNameOwner = function(name, callback) {
       this.invokeDbus({ 'member': 'GetNameOwner', signature: 's', body: [name]}, callback);
    };

    this.nameHasOwner = function(name, callback) {
       this.invokeDbus({ 'member': 'GetNameOwner', signature: 's', body: [name]}, callback);
    };

    // todo: subscribe for NameOwnerChanged / NameLost 
};
