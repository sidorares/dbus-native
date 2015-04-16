var dbus = require('../index.js');


var s = dbus.createServer(function(client) {
   client.on('message', function(m) {
      console.log('message from client:', m);

      if (m.member == 'Hello') {
        console.log('sending hello reply');
        client.message({
           "serial": 1,
           "destination": ":1.345",
           "replySerial": m.serial,
           "signature": "s",
           "sender": "org.freedesktop.DBus",
           "type": 2,
           "flags": 1,
           "body": [
              ":1.345"
           ]
        });
      }
  });
}).listen(4000);
