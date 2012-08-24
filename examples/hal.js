//dbus-send --print-reply --system --dest=org.freedesktop.Hal.Manager /org/freedesktop/Hal/Manager org.freedesktop.Hal.Manager.GetAllDevices
var dbus = require('../index.js');

var bus = dbus.createClient({socket: '/var/run/dbus/system_bus_socket'});
//var bus = dbus.createClient({port: 7000});
bus.invoke({ 
   path: '/org/freedesktop/Hal/Manager',
   destination: 'org.freedesktop.Hal.Manager',
   interface: 'org.freedesktop.Hal.Manager',
   member: 'GetAllDevices'
}, function(err, devices) {
   if (err)
      console.log('ERROR:' + err);
   else
      console.log('Network status:', devices);
});

//bus.on('NameAcquired', function(msg) {
//    console.log('I can haz signalz', msg);
//});
