#!/usr/bin/env node --harmony_proxies

var dbus = require('../index.js');
var upower = dbus.systemBus()
    .getService('org.freedesktop.UPower')
    .getObject('/org/freedesktop/UPower');

var up = upower.as('org.freedesktop.UPower');

up.EnumerateDevices(function(err, devices) {
   if (err)
      console.log('ERROR:' + err);
   else
      console.log('Power devices:', devices);
});

var introspectable = upower.as('org.freedesktop.DBus.Introspectable');
introspectable.Introspect(function(err, xml) {
     console.log('Introspect: ', err, xml);
});

//up.DaemonVersion(function(err, res) {
//     console.log('DV:', err, res);
//});

var db = dbus.systemBus().getService('org.freedesktop.DBus').getObject('/org/freedesktop/DBus').as('org.freedesktop.DBus');
//db.ListNames(function(err, names) {
//    console.log(names);
//});

//db.ListActivatableNames(console.log);
db.StartServiceByName('org.freedesktop.Hal', 0, console.log);
