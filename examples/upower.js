var dbus = require('../index.js');
var bus = dbus.systemBus();
bus.invoke({ 
   destination: 'org.freedesktop.UPower',
   path:        '/org/freedesktop/UPower',
   interface:   'org.freedesktop.UPower',
   member:      'EnumerateDevices'
}, function(err, devices) {
   if (err)
      console.log('ERROR:' + err);
   else
      console.log('Power devices:', devices);
});
