// org.freedesktop.DBus.RequestName

// note: you need to add permissions to register name
// see http://stackoverflow.com/questions/4560877/dbus-bus-request-name-connections-are-not-allowed-to-own-the-service 

var dbus = require('../index.js');

var reply = '<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"\n                      "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">\n<!-- GDBus 2.32.3 -->\n<node>\n  <interface name="org.freedesktop.DBus.Properties">\n    <method name="Get">\n      <arg type="s" name="interface_name" direction="in"/>\n      <arg type="s" name="property_name" direction="in"/>\n      <arg type="v" name="value" direction="out"/>\n    </method>\n    <method name="GetAll">\n      <arg type="s" name="interface_name" direction="in"/>\n      <arg type="a{sv}" name="properties" direction="out"/>\n    </method>\n    <method name="Set">\n      <arg type="s" name="interface_name" direction="in"/>\n      <arg type="s" name="property_name" direction="in"/>\n      <arg type="v" name="value" direction="in"/>\n    </method>\n    <signal name="PropertiesChanged">\n      <arg type="s" name="interface_name"/>\n      <arg type="a{sv}" name="changed_properties"/>\n      <arg type="as" name="invalidated_properties"/>\n    </signal>\n  </interface>\n  <interface name="org.freedesktop.DBus.Introspectable">\n    <method name="Introspect">\n      <arg type="s" name="xml_data" direction="out"/>\n    </method>\n  </interface>\n  <interface name="org.freedesktop.DBus.Peer">\n    <method name="Ping"/>\n    <method name="GetMachineId">\n      <arg type="s" name="machine_uuid" direction="out"/>\n    </method>\n  </interface>\n  <interface name="ca.desrt.dconf.WriterInfo">\n    <method name="Blame">\n      <arg type="s" name="tag" direction="out"/>\n    </method>\n    <property type="s" name="ShmDirectory" access="read"/>\n  </interface>\n  <node name="user"/>\n</node>\n'


var bus = dbus.systemBus();
// this is going to be bus.register(name) in api
bus.invoke({ 
   path:        '/org/freedesktop/DBus',
   destination: 'org.freedesktop.DBus',
   interface:   'org.freedesktop.DBus',
   member:      'RequestName',
   signature:   'su',
   body: [ 'com.github.sidorares.node.dbus.Example', 0x01 ] // TODO: core DBus api constants (they are not related to transport)
}, function(err, flags) {
   if (err)
      console.log('ERROR:' + err);
   else
      console.log('ReplaceName status:', flags);
});

bus.connection.on('message', function(msg) {
    if (msg.type == 1) {
    console.log(msg);
    bus.invoke({
        destination: msg.sender,   
        type: dbus.messageType.methodReturn,
        replySerial: msg.serial,
        signature: 's',
        body: [reply]
    });

    }
});
