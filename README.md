node-dbus
===========
D-bus protocol client and server for node.js

Installation
------------

```shell
npm install dbus-native
```
or

```shell
git clone https://github.com/sidorares/node-dbus # clone the repo
cd node-dbus 
npm install # install dependencies
sudo cp examples/com.github.sidorares.dbus.Example.conf /etc/dbus-1/system.d/ # if you want to test examples/service.js
```

Usage
------

    var dbus = require('dbus-native');
    // TODO: docs for options
    var connection = dbus(options);
    // raw message: (everything else is wrapper around message)
    // same as dbus-send org.freedesktop.dbus /org/freedesktop/dbus Hello
    var cookie = connection.message({
      type: dbus.messageType.functionCall, // optional, default to functionCall
      // flags:     // optional, default to no flags
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      destination: 'org.freedesktop.DBus'
      member: 'Hello'
    });

    connection.on('message', function(message) {
      // handle reply
    });

    // higher-level API:
    connection.invoke(..., callback);

    // TODO: introspection and proxies

TODO: examples using dbus-send and corresponding dbus-native api. 
