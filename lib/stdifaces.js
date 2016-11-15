const utils          = require ('./utils')
const inspect        = require ('util').inspect
const constants      = require ('./constants')
const xmlbuilder     = require ('xmlbuilder')
const parseSignature = require ('./signature')

inspect.defaultOptions.colors = true
inspect.defaultOptions.breakLength = 1

// Whether to set this file's functions into debugging (verbose) mode
const DEBUG_THIS_FILE = false

// Allows for setting all files to debug in once statement instead of manually setting every flag
const DEBUG = DEBUG_THIS_FILE || utils.GLOBAL_DEBUG

// TODO: use xmlbuilder

var xmlHeader = '<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"\n' +
    '    "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">';
var stdIfaces;

module.exports = function(msg, bus) {
    if (msg['interface'] === 'org.freedesktop.DBus.Introspectable' && msg.member === 'Introspect') {
        // When receiving an introspection call, check if we have the service in the 'exposedServices' Map
        if (bus.exposedServices.has (msg.destination)) {

            // Get the path and split it into individual components to traverse the DBusService
            let paths = msg.path.split ('/')
            // Remove the initial empty entry left by '/'...
            paths.shift()
            //... and add the '/'
            if (paths[0] === '') // condition to avoid and empty elem when only '/' is asked for instrospection
                paths = ['/']
            else
                paths.unshift ('/')

            // Get the corresponding service
            let service = bus.exposedServices.get (msg.destination)

            // Traverse the service according to the requested path
            let abord = false
            let currObj = service
            // let currObj = service['/']
            let xmlIntrospectionData
            let reply

            while (!abord && paths.length !== 0) {
                let nextPathComponent = paths.shift() // take the next path component to reach the next object

                // If there is an object at that object component...
                if (typeof currObj[nextPathComponent] !== 'undefined') {
                    //... traverse it and start again
                    currObj = currObj[nextPathComponent]
                    // console.log ('now: ' + currObj)
                }
                //...if there is no object at this path, stop recursing and return empty introspection data
                else {
                    abord = true
                }
            }

            /*
                At this point, we have finished traversing the DBusService according to the path.
                Two possibilities: either we have traversed successfully and we have a DBusObject on which we can call
                'introspect()' to generate introspection data.
                Or we have exited because there was not object at a path component, in which case we return empty
                introspection data.
            */
            if (!abord) {
                // If we have an object, call its introspection function
                xmlIntrospectionData = currObj.introspect()
            }
            else {
                // If we don't have an object, return empty introspection data
                let xml = xmlbuilder.create ('node', {headless: true}) // Create root element without the <?xml version="1.0"?>
        		                    .dtd ('-//freedesktop//DTD D-BUS Object Introspection 1.0//EN',
        		                          'http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd')
        		                    .root()
                xmlIntrospectionData = xml.end ({pretty: true})
            }

            reply = {
                type: constants.messageType.methodReturn,
                replySerial: msg.serial,
                destination: msg.sender,
                signature:'s',
                body: [xmlIntrospectionData]
            };
            bus.connection.message(reply);

            return true
        }
        // If the service is not in 'exposedServices', it doesn't use the new API -> fallback to old behavior
        else {
            console.log ('[OLD INTERFACE]')
            if (msg.path == '/')
            msg.path = '';

            var resultXml = [xmlHeader];
            var nodes = {};
            var obj;
            // TODO: this is not very efficient for large number of exported objects
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
            return true
        }
    } else if (msg['interface'] === 'org.freedesktop.DBus.Properties') {
        // Deal with new API
        if (bus.exposedServices.has (msg.destination)) {
            let targetService = bus.exposedServices.get (msg.destination)
            let pathComponents = msg.path.split ('/')
            pathComponents.shift() // remove empty '' due to initial '/'
            pathComponents.unshift('/') // add the initial '/' back

            // Traverse the object hierarchy of the DBusService and its DBusObjects (this is caled folding, by the way)
            let targetObject = pathComponents.reduce( (currObj, pathComp) => currObj[pathComp], targetService)

            // Prepare reply message
            let reply = {
                type: constants.messageType.methodReturn,
                replySerial: msg.serial,
                destination: msg.sender
            }

            // Deal with Get / Set call
            if (msg.member === 'Get' || msg.member === 'Set') {
                let propName = msg.body[1]
                let targetIface = targetObject[msg.body[0]]
                let propValue = targetIface[propName]
                let propObj = targetIface._ifaceDesc.properties.get (propName)
                let propType = propObj[Object.keys(propObj)[0]]
                // Properties can't be "multiple values", so unwrap the array
                let tree = parseSignature (propType)[0]

                // If it's a GET request, return the property value
                if (msg.member === 'Get') {

                    // In case we requested a non-existing property, fail gracefully
                    if (propValue === undefined) {
                        let errStr = `No such property '${propName}' at '${msg.path}'`
                        bus.sendError (msg, 'org.freedesktop.DBus.Error.InvalidArgs', errStr)
                        return true
                    }

                    /*
                        When the user defines his classes, he defines the properties in the new API format, so we have
                        to translate the value to the old API format to marshall and send it over the wire.
                    */
                    let translatedPropValue = utils.fromNewToOldAPI (propValue, tree)

                    /*
                        This is CORRECT: we wrap the value in an additionnal level of array nesting If the value is
                        already an array. This is the expected behavior: if it's already an array, it means it's a
                        container type (which must be wrapped in a level of array nesting to be marshalled).
                        If it's not (a single type value), then there should not be more nesting
                    */
                    if (Array.isArray (translatedPropValue))
                        translatedPropValue = [translatedPropValue]

                    // Otherwise, return the value
                    //TODO: TYPE CHECK
                    reply.signature = 'v'
                    reply.body = [[propType, translatedPropValue]]

                    bus.connection.message (reply)
                }
                // If it's a SET method, set the new property and emit 'PropertiesChanged'
                else {
                    let msgBody = msg.body[2]

                    // Extract actual value to assign to the property.
                    let data = parseSignature.valueFromTree (msgBody)

                    // console.log (`data: ${inspect( data)}`)

                    if (data === undefined) {
                        // If we could not extract a value, return a proper error letting the user know
                        let errName = 'org.freedesktop.DBus.Error.InvalidArgs'
                        let errText = 'Could not parse value from message body, is it a new type?'
                        let signalBody

                        if (DEBUG) {
                            console.log ('Could not parse data, Set operation aborted. (Data was:\n' + inspect (msgBody) + ')')
                        }

                        bus.sendError (msg, errName, errText)
                        return true
                    }

                    targetIface[propName] = utils.fromOldToNewAPI (data, tree)

                    data = Array.isArray (data) ? [data] : data

                    // Now that the property is changed, emit the 'PropertiesChanged' signal
                    signalBody = [
                        targetIface._ifaceName, // name of the interface containing the property we are changing
                        [[propName, [propType, data]]], // the new properties value
                        [] // no invalidated properties
                    ]

                    /*
                        Several things going on here:
                        1) we need to send the 'PropertiesChanged' signal to tell others our property changed and
                           especially for the users of dbus-native that use DBusProxy (which listens for this signal
                           to update the value of its local properties)
                        2) we need to give the caller an (empty) answer so that is doesn't hang
                        3) we send the signal BEFORE the answer, so that it leaves a chance for the signal to propagate
                           (and DBusProxy to update their local values) before the user makes another call
                    */
                    bus.sendSignal (
                        msg.path, // path of the object emitting the signal
                        'org.freedesktop.DBus.Properties', // iface name of the signal
                        'PropertiesChanged', //'PropertiesChanged', // signal name
                        'sa{sv}as',
                        signalBody
                    )

                    bus.connection.message (reply) // We still answer so that the client doesn't hang, waiting for a reply

                    return true
                }
            } else if (msg.member === 'GetAll') {
                bus.sendError (msg, 'org.freedesktop.DBus.Error.NotImplemented', `'GetAll' is not implemented in dbus-native yet`)
            }

            return true
        }

        // Old API
        var interfaceName = msg.body[0];
        var obj = bus.exportedObjects[msg.path];

        // TODO: !obj -> UnknownObject  http://www.freedesktop.org/wiki/Software/DBusBindingErrors
        if (!obj || !obj[interfaceName])
        {
            // TODO:
            bus.sendError(msg, 'org.freedesktop.DBus.Error.UnknownMethod', 'Uh oh oh(2)');
            return true
        }
        var impl = obj[interfaceName][1];

        var reply = {
            type: constants.messageType.methodReturn,
            replySerial: msg.serial,
            destination: msg.sender
        };
        if (msg.member === 'Get' || msg.member === 'Set') {
            if (DEBUG) {
                console.log ('Get - Set')
                console.log (inspect(msg, {depth: Infinity}))
                console.log ('----')
            }

            var propertyName = msg.body[1];
            var propType = obj[interfaceName][0].properties[propertyName];

            if (msg.member === 'Get') {
                // The ifaceDesc object should contain a property with the name of the property
                var propValue = impl[propertyName];

                // Check if the property does exist
                if (propValue === undefined) {
                    let errName = 'org.freedesktop.DBus.Error.InvalidArgs'
                    let errText = 'No such property \'' + propertyName + '\''
                    bus.sendError (msg, errName, errText)
                    return true
                }
                reply.signature = 'v';
                reply.body = [[propType, propValue]];
            } else {
                let msgBody = msg.body[2]
                let data

                if (DEBUG) console.log ('=== Set ===')

                // Extract actual value to assign to the property.
                data = parseSignature.valueFromTree (msgBody)
                if (data === undefined) {
                    // If we could not extract a value, return a proper error letting the user know
                    let errName = 'org.freedesktop.DBus.Error.InvalidArgs'
                    let errText = 'Setting complex-type properties is not yet supported.'
                    let signalBody

                    if (DEBUG) {
                        console.log ('Could not parse data, Set operation aborted. (Data was:\n' + inspect (msgBody) + ')')
                    }
                    /*
                        For now, return a DBus Error to tell the user that setting complex data-type properties
                        is not yet supported.
                    */
                    bus.sendError (msg, errName, errText)
                    return true
                }

                if (false && DEBUG) {
                    console.log ('Parsed Data:\n', inspect (data))
                    console.log ('\nimpl[propertyName] (before):\n' + inspect (impl[propertyName]))
                }

                /*
                    This line is correct, it is indeed IF 'data' is ALREADY an array, then add brackets '[' & ']'
                    and IF it is NOT already an array, DON'T add the brackets.
                    Explanation: all container types (array, STRUCT () and DICT {} are implemented as Javascript arrays
                    and single types are not.
                    For recursivity reasons, 'valueFromTree' returns the value as Javascript (so single value for single values and array of values for the other types). Then our implementation requires that container
                    types MUST be enclosed in brackets.
                    So the story is simple: if 'data' is an array, it means it's a container so wrap it in brackets,
                    but if it's not, then it is a single type, and it can be assigned directly, as-is.
                */
                impl[propertyName] = Array.isArray (data) ? [data] : data

                // Now that the property is changed, emit the 'PropertiesChanged' signal
                signalBody = [
                    interfaceName, // name of the interface containing the property we are changing
                    [[propertyName, [propType, impl[propertyName]]]], // the new properties value
                    [] // no invalidated properties
                ]

                bus.sendSignal (
                    msg.path, // path of the object emitting the signal
                    'org.freedesktop.DBus.Properties', // iface name of the signal
                    'PropertiesChanged', // signal name
                    'sa{sv}as',
                    signalBody
                )

                if (false && DEBUG) {
                    console.log ('\nimpl[propertyName] (after):\n' + inspect (impl[propertyName]))
                }
                // impl[propertyName] = 1234; // TODO: read variant and set property value
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
        return true
    } else if (msg['interface'] === 'org.freedesktop.DBus.Peer') {
        var reply = {
            type: constants.messageType.methodReturn,
            replySerial: msg.serial,
            destination: msg.sender
        };
        if (msg.member === 'Ping') {
            // empty body
        } else if (msg.member === 'GetMachineId') {
            // It's WAY better to return a proper error than faking success and return arbitrary, nonsense value!
            bus.sendError (msg, 'org.freedesktop.DBus.Error.NotImplemented', `'GetMachineId' not implemented in dbus-native yet.`)
            return true
            // reply.signature = 's';
            // reply.body = ['This is a machine id. TODO: implement'];
        }

        bus.connection.message(reply);
        return true
    }

    /*
        If none of these checks passed, it means it's not a standard interface, so return false so that parsing
        can continue for the other, custom interfaces.
    */
    return false
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


module.exports.stdPeerIface = function stdPeerIface (xmlRoot) {
    // First create the '<interface>' node, with its name
    let xml = xmlRoot.ele ('interface', {name: 'org.freedesktop.DBus.Peer'})

    // Add the Ping and GetMachineId methods
    xml.ele ('method', {name: 'Ping'})
    let getMachineId = xml.ele ('method', {name: 'GetMachineId'})

    getMachineId.ele ('arg', {type: 's', name: 'machine_uuid', direction: 'out'})

    // No properties nor signal for the Peer interface

    return xml
}

module.exports.stdIntrospectableIface = function stdIntrospectableIface (xmlRoot) {
    // First create the '<interface>' node, with its name
    let xml = xmlRoot.ele ('interface', {name: 'org.freedesktop.DBus.Introspectable'})

    // Add the Introspect method
    let introspect = xml.ele ('method', {name: 'Introspect'})
    introspect.ele ('arg', {type: 's', name: 'xml_data', direction: 'out'})

    // No properties nor signal for the Introspectable interface

    return xml
}

module.exports.stdPropertiesIface = function stdPropertiesIface (xmlRoot) {
    // First create the '<interface>' node, with its name
    let xml = xmlRoot.ele ('interface', {name: 'org.freedesktop.DBus.Properties'})

    // Add the Get, Set and GetAll methods
    let get = xml.ele ('method', {name: 'Get'})
    get.ele ('arg', {type: 's', name: 'interface_name', direction: 'in'})
    get.ele ('arg', {type: 's', name: 'property_name', direction: 'in'})
    get.ele ('arg', {type: 'v', name: 'value', direction: 'out'})

    let set = xml.ele ('method', {name: 'Set'})
    set.ele ('arg', {type: 's', name: 'interface_name', direction: 'in'})
    set.ele ('arg', {type: 's', name: 'property_name', direction: 'in'})
    set.ele ('arg', {type: 'v', name: 'value', direction: 'in'})

    let getAll = xml.ele ('method', {name: 'GetAll'})
    getAll.ele ('arg', {type: 's', name: 'interface_name', direction: 'in'})
    getAll.ele ('arg', {type: 'a{sv}', name: 'props', direction: 'out'})

    // Add the PropertiesChanged signal

    let signal = xml.ele ('signal', {name: 'PropertiesChanged'})
    signal.ele ('arg', {type: 's', name: 'interface_name'})
    signal.ele ('arg', {type: 'a{sv}', name: 'changed_properties'})
    signal.ele ('arg', {type: 'as', name: 'invalidated_properties'})

    return xml
}
