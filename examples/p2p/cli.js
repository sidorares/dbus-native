const dbus = require('../../index');

let count = 0;
const conn = dbus.createConnection({ port: 3333, handshake: 'none' });
conn.on('message', msg => {
  if (msg.serial) {
    msg.serial += 1;
  } else {
    msg.serial = 1;
  }
  conn.message(msg);
  count++;
});

setInterval(() => {
  console.log(count);
  count = 0;
}, 1000);
