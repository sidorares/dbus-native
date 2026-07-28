const dbus = require('../../index');
const addrx11 = require('../../lib/address-x11');

addrx11((err, address) => {
  const bus = dbus.sessionBus({ busAddress: address });
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
});
