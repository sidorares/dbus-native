const dbus = require('../../index');

const bus = dbus.sessionBus();

const destination = 'vasya.pupkin';
bus.invoke(
  {
    path: '/0/1',
    destination,
    interface: 'org.vasya.pupkin.reverser',
    member: 'reverse',
    signature: 's',
    body: ['does it really work?']
  },
  (err, res) => {
    console.log(res);
  }
);
