var dbus = require('../../index.js');
var bus = dbus.sessionBus();

var counter = 0;
var destination = 'vasya.pupkin';
function c() {
bus.invoke({ 
    path: '/', 
    destination: destination, 
    'interface': 'org.pup.reverse', 
    member: 'doStuff', 
    signature: 's', body: ['does it really work?']
}, function(err, res) {
    //console.log(err, res);
    counter++;
    c();
});
}

c();
c();
c();

setInterval(function() {
    console.log(counter);
    counter = 0;
}, 1000);
