var dbus = require('../index.js');

var reply = '<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"\n                      "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">\n<!-- GDBus 2.32.3 -->\n<node>\n  <interface name="org.freedesktop.DBus.Properties">\n    <method name="Get">\n      <arg type="s" name="interface_name" direction="in"/>\n      <arg type="s" name="property_name" direction="in"/>\n      <arg type="v" name="value" direction="out"/>\n    </method>\n    <method name="GetAll">\n      <arg type="s" name="interface_name" direction="in"/>\n      <arg type="a{sv}" name="properties" direction="out"/>\n    </method>\n    <method name="Set">\n      <arg type="s" name="interface_name" direction="in"/>\n      <arg type="s" name="property_name" direction="in"/>\n      <arg type="v" name="value" direction="in"/>\n    </method>\n    <signal name="PropertiesChanged">\n      <arg type="s" name="interface_name"/>\n      <arg type="a{sv}" name="changed_properties"/>\n      <arg type="as" name="invalidated_properties"/>\n    </signal>\n  </interface>\n  <interface name="org.freedesktop.DBus.Introspectable">\n    <method name="Introspect">\n      <arg type="s" name="xml_data" direction="out"/>\n    </method>\n  </interface>\n  <interface name="org.freedesktop.DBus.Peer">\n    <method name="Ping"/>\n    <method name="GetMachineId">\n      <arg type="s" name="machine_uuid" direction="out"/>\n    </method>\n  </interface>\n  <interface name="ca.desrt.dconf.WriterInfo">\n    <method name="Blame">\n      <arg type="s" name="tag" direction="out"/>\n    </method>\n    <property type="s" name="ShmDirectory" access="read"/>\n  </interface>\n  <node name="user"/>\n</node>\n'
console.log(reply);

var introReq = {
    "type": 1,
    "flags": 0,
    "serial": 199,
    "path": "/",
    "destination": ":1.140",
    "interface": "org.freedesktop.DBus.Introspectable",
    "member": "Introspect",
    "sender": ":1.139",
    "signature": "",
    "body": null
};

var conn = dbus({socket: '\0/tmp/dbus-m9L9qWj7Q8'});
conn.on('connect', function(uuid) {

console.log(uuid);

var helloMsg = {
   path: '/org/freedesktop/DBus',
   destination: 'org.freedesktop.DBus',
   interface: 'org.freedesktop.DBus',
   member: 'Hello',
};

conn.message(helloMsg);

conn.on('message', function(msg) {

   console.log('MSG!', msg);

   if (msg.interface == introReq.interface && msg.member == introReq.member) {
       msg.path = '/org/freedesctop/DBus';
       msg.destination = 'org.freedesktop.DBus';
       msg.replySerial = introReq.serial;
       //msg.signature = 's';
       //msg.body = [reply];
       msg.type = dbus.messageType.methodReturn; 
       conn.message(helloMsg);
   }
})

});


