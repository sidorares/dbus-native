const dbus = require('../../index');

// command line to test:
// dbus-send --print-reply --type=method_call --dest='some.name' '/com/github/sidorares/1' com.example.service.respondWithDouble string:'test123'
// dbus-send --print-reply --type=method_call --dest='some.name' '/com/github/sidorares/1' com.example.service.timesTwo double:123.4567

const bus = dbus.sessionBus();
const name = 'some.name';
bus.requestName(name, 0);

const exampleIface = {
  name: 'com.example.service',
  methods: {
    doStuff: ['s', 's'],
    timesTwo: ['d', 'd'],
    respondWithDouble: ['s', 'd']
  },
  signals: {
    testsignal: ['us', 'name1', 'name2']
  },
  properties: {
    TestProperty: 'y'
  }
};

const example = {
  respondWithDouble: function (s) {
    console.log(`Received "${s}'`);
    return 3.14159;
  },
  timesTwo: function (d) {
    console.log(d);
    return d * 2;
  },
  doStuff: function (s) {
    return `Received "${s}" - this is a reply`;
  },
  TestProperty: 42,
  emit: function (name, param1, param2) {
    console.log('signal emit', name, param1, param2);
  }
};
bus.exportInterface(example, '/com/github/sidorares/1', exampleIface);
bus.exportInterface(example, '/com/github/sidorares/2', exampleIface);

//setInterval( function() {
//    example.emit('testsignal', Date.now(), 'param2');
//}, 1000);

//});
//
