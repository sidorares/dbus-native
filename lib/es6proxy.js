// ES5 harmony-proxy based dbus proxy
//
// work in progress

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

