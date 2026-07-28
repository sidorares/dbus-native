const dbus = require('../../index');

const bus = dbus.sessionBus();
const name = 'vasya.pupkin';
bus.connection.on('message', msg => {
  if (
    msg.destination === name &&
    msg['interface'] === 'org.vasya.pupkin.reverser' &&
    msg.path === '/0/1'
  ) {
    const reply = {
      type: dbus.messageType.methodReturn,
      destination: msg.sender,
      replySerial: msg.serial,
      sender: name,
      signature: 's',
      body: [msg.body[0].split('').reverse().join('')]
    };
    bus.invoke(reply);
  }
});
bus.requestName(name, 0);
