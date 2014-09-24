var constants      = require('./constants');
var parseSignature = require('./signature');

// TODO: use xmlbuilder

var xmlHeader = '<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"\n' +
    '    "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">';
var stdIfaces;

function respondError(bus, msg, name, text)
{
    var reply = {
        type: constants.messageType.error,
        replySerial: msg.serial,
        destination: msg.sender,
        errorName: name,
        signature: 's',
        body: [ text ]
    }
    bus.connection.message(msg);
}

module.exports = function(msg, bus) {
    if (msg['interface'] === 'org.freedesktop.DBus.Introspectable' && msg.member === 'Introspect') {
        if (msg.path == '/')
            msg.path = '';

        var resultXml = [xmlHeader];
        var nodes = {};
        var obj;
        // TODO: this is not very efficiant for large number of exported objects
        // need to build objects tree as they are exported and walk this tree on introspect request
        for (var path in bus.exportedObjects) {
           if (path.indexOf(msg.path) === 0) {// objects path starts with requested
               obj = bus.exportedObjects[msg.path];
               if (obj)
                   nodes[msg.path] = obj;
               else {
                   if (path[msg.path.length] != '/')
                       continue;
                   var localPath = path.substr(msg.path.length);
                   var pathParts = localPath.split('/');
                   var localName = pathParts[1];
                   nodes[localName] = null;
               }
           }
        }

        var length = Object.keys(nodes).length;
        var ifaceName;
        if (length === 0)
            resultXml.push('<node/>');
        else if (length === 1) {
            obj = nodes[Object.keys(nodes)[0]];
            if (obj) {
              resultXml.push('<node>');
                  for (ifaceName in obj) {
                      resultXml.push(interfaceToXML(obj[ifaceName][0]));
                  }
                  resultXml.push(stdIfaces);
              resultXml.push('</node>');
            } else {
              resultXml.push('<node>\n  <node name="' + Object.keys(nodes)[0] + '"/>\n  </node>');
            }

        } else {
            resultXml.push('<node>');
            for (var name in nodes) {
                if (nodes[name] === null)
                    resultXml.push('  <node name="' + name + '" />');
                else {
                    obj = nodes[name];
                    resultXml.push('  <node name="' + name + '" >');
                    for (ifaceName in obj) {
                        resultXml.push(interfaceToXML(obj[ifaceName][0]));
                    }
                    resultXml.push(stdIfaces);
                    resultXml.push('  </node>');
                }
            }
            resultXml.push('</node>');
        }

        var reply = {
            type: constants.messageType.methodReturn,
            replySerial: msg.serial,
            destination: msg.sender,
            signature:'s',
            body: [resultXml.join('\n')]
        };
        bus.connection.message(reply);
        return 1;
    } else if (msg['interface'] === 'org.freedesktop.DBus.Properties') {
        var interfaceName = msg.body[0];
        var obj = bus.exportedObjects[msg.path];
        // TODO: !obj -> UnknownObject  http://www.freedesktop.org/wiki/Software/DBusBindingErrors
        if (!obj || !obj[interfaceName])
        {
            // TODO:
            bus.sendError(msg, 'org.freedesktop.DBus.Error.UnknownMethod', 'Uh oh oh');
            return 1;
        }
        var impl = obj[interfaceName][1];

        var reply = {
            type: constants.messageType.methodReturn,
            replySerial: msg.serial,
            destination: msg.sender
        };
        if (msg.member === 'Get' || msg.member === 'Set') {
            var propertyName = msg.body[1];
            var propType = obj[interfaceName][0].properties[propertyName];
            if (msg.member === 'Get') {
                var propValue = impl[propertyName];
                reply.signature = propType;
                reply.body = [propValue];
            } else {
                impl[propertyName] = 1234; // TODO: read variant and set property value
            }
        }
        else if (msg.member == 'GetAll') {
            reply.signature = 'a{sv}';
            var props = [];
            for (var p in obj[interfaceName][0].properties) {
                var propertySignature = obj[interfaceName][0].properties[p];
                props.push([ p, [propertySignature, impl[p]] ]);
            }
            reply.body = [props];
        }
        bus.connection.message(reply);
        return 1;
    } else if (msg['interface'] === 'org.freedesktop.DBus.Peer') {
        // TODO: implement bus.replyTo(srcMsg, signature, body) method
        var reply = {
            type: constants.messageType.methodReturn,
            replySerial: msg.serial,
            destination: msg.sender
        };
        if (msg.member === 'Ping') {
            // empty body
        } else if (msg.member === 'GetMachineId') {
            reply.signature = 's';
            reply.body = ['This is a machine id. TODO: implement'];
        }
        bus.connection.message(reply);
        return 1;
    }
    return 0;
};

// TODO: move to introspect.js
function interfaceToXML(iface) {
   var name;
   var result = [];
   var dumpArgs = function(argsSignature, argsNames, direction) {
       if (!argsSignature) return;
       var args = parseSignature(argsSignature);
           args.forEach(function(arg, num) {
           var argName = argsNames ? argsNames[num] : direction + num;
           var dirStr = direction === 'signal' ? '' : '" direction="' + direction;
           result.push('      <arg type="' + dumpSignature([arg]) +
               '" name="' + argName + dirStr + '" />');
       });
   };
   result.push('  <interface name="' + iface.name + '">');
   if (iface.methods) {
       for (name in iface.methods)
       {
           var method = iface.methods[name];
           result.push('    <method name="' + name + '">');
               dumpArgs(method[0], method[2], 'in');
               dumpArgs(method[1], method[3], 'out');
           result.push('    </method>');
       }
   }
   if (iface.signals) {
       for (name in iface.signals) {
           var signal = iface.signals[name];
           result.push('    <signal name="' + name + '">');
               dumpArgs(signal[0], signal.slice(1), 'signal');
           result.push('    </signal>');
       }
   }
   if (iface.properties) {
       for (name in iface.properties) {
           // TODO: decide how to encode access
           result.push('    <property name="' + name + '" type="' + iface.properties[name] + '" access="readwrite"/>');
       }
   }
   result.push('  </interface>');
   return result.join('\n');
}

function dumpSignature(s) {
    var result = [];
    s.forEach(function(sig) {
        result.push(sig.type + dumpSignature(sig.child));
        if (sig.type === '{') result.push('}');
        if (sig.type === '(') result.push(')');
    });
    return result.join('');
}
module.exports.interfaceToXML = interfaceToXML;
stdIfaces = '  <interface name="org.freedesktop.DBus.Properties">\n    <method name="Get">\n      <arg type="s" name="interface_name" direction="in"/>\n      <arg type="s" name="property_name" direction="in"/>\n      <arg type="v" name="value" direction="out"/>\n    </method>\n    <method name="GetAll">\n      <arg type="s" name="interface_name" direction="in"/>\n      <arg type="a{sv}" name="properties" direction="out"/>\n    </method>\n    <method name="Set">\n      <arg type="s" name="interface_name" direction="in"/>\n      <arg type="s" name="property_name" direction="in"/>\n      <arg type="v" name="value" direction="in"/>\n    </method>\n    <signal name="PropertiesChanged">\n      <arg type="s" name="interface_name"/>\n      <arg type="a{sv}" name="changed_properties"/>\n      <arg type="as" name="invalidated_properties"/>\n    </signal>\n  </interface>\n  <interface name="org.freedesktop.DBus.Introspectable">\n    <method name="Introspect">\n      <arg type="s" name="xml_data" direction="out"/>\n    </method>\n  </interface>\n  <interface name="org.freedesktop.DBus.Peer">\n    <method name="Ping"/>\n    <method name="GetMachineId">\n      <arg type="s" name="machine_uuid" direction="out"/>\n    </method>\n  </interface>';
