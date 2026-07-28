const dbus = require('../../index');

dbus
  .createServer(conn => {
    conn.on('message', msg => {
      if (msg.serial) {
        msg.serial += 1;
      } else {
        msg.serial = 1;
      }
      conn.message(msg);
    });
    conn.message({ interface: 'yes' });
  })
  .listen(3333);
