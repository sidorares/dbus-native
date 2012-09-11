var dbus = require('../../index.js');
var bus = dbus.sessionBus();
var reverse =  function(str) {
   return str.split('').reverse().join('');
};
var name = "vasya.pupkin";
bus.requestName(name, 0);
bus.setMethodCallHandler('/', 'org.pup.reverse', 'doStuff', [reverse, 's']);
/*
var interfaces = {};
var obj = bus.exportObject({
    name: 'vasya.pupkin',
    path: '/',
    interface: 'org.vasya.pupkin.reverser', 
    implementation: reverser,
    introspect: {
        methods: {
            reverse: [
               {
                  str: 's'
               }, { 
                  rstr: 's'
               }, {
                 "org.freedesktop.DBus.Deprecated": true
               }
            ]
        },
        signals: {
            ithappened: [
               val1: 'y',
               val2: 's'
            ]
        }
        properties: {
            TestProperty: 'y'
        }
    } 
};
*/
