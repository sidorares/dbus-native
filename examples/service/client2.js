// The client half of server2.js: calls it every two seconds and logs
// everything that arrives on the connection.

const dbus = require('../../index');

const bus = dbus.sessionBus();
const name = 'some.name';
const iface = 'com.example.service';

function test() {
  bus.invoke(
    {
      path: '/',
      destination: name,
      interface: iface,
      member: 'doStuff',
      signature: 's',
      body: ['does it really work?']
    },
    (err, res) => {
      console.log(err, res);
    }
  );
}

bus.addMatch("type='signal'");
bus.connection.on('message', console.log);

setInterval(test, 2000);
test();
