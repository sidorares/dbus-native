node-dbus
===========

D-bus protocol client and server for node.js

    var dbus = require('dbus-native');
    // TODO: docs for options
    var connection = dbus(options);
    // raw message: (everything else is wrapper around message)
    // same as dbus-send org.freedesktop.dbus /org/freedesktop/dbus Hello
    var cookie = connection.message({
      type: dbus.messageType.functionCall, // optional, default to functionCall
      // flags:     // optional, default to no flags
      object: "org.freedesktop.dbus",
      interface: "/org/freedesktop/dbu",
      method: "Hello"
    });

    connection.on('message', function(message) {
      // handle reply
    });

    // higher-level API:
    connection.invoke(..., callback);

    // TODO: introspection and proxies

TODO: examples using dbus-send and corresponding dbus-native api. 
