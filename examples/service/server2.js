var dbus = require('../../index.js');

//var addrx11 = require('../../lib/address-x11');
//addrx11(function(err, address) {
//var bus = dbus.sessionBus({busAddress: address});

var bus = dbus.sessionBus();
var name = 'some.name';
bus.requestName(name, 0);

var exampleIface = {
    name: 'com.example.service',
    methods: {
        doStuff: ['s', 's']
    },
    signals: {
        testsignal: [ 'us', 'name1', 'name2' ]
    },
    properties: {
       TestProperty: 'y'
    }
};

var example = {
    doStuff: function(s) {
        return 'Received "' + s + '" - this is a reply'; 
    },
    TestProperty: 42,
    emit: function(name, param1, param2) {
        console.log('signal emit', name, param1, param2);
    }
};
bus.exportInterface(example, '/com/github/sidorares/1', exampleIface);
bus.exportInterface(example, '/com/github/sidorares/2', exampleIface);

setInterval( function() {
    example.emit('testsignal', Date.now(), 'param2');
}, 1000);

//});
