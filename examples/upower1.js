var dbus = require('../index.js');
var up = dbus.systemBus()
    .getService('org.freedesktop.UPower')
    .getObject('/org/freedesktop/UPower')
    .as('org.freedesktop.UPower');

up.EnumerateDevices(function(err, devices) {
   if (err)
      console.log('ERROR:' + err);
   else
      console.log('Power devices:', devices);
});
