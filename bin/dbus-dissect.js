// simple script to monitor incoming/outcoming dbus messages
// needs a lot of cleanup but does the job

var net = require('net');
var abs = require('abstract-socket');
var hexy = require('../lib/hexy').hexy;
var address = process.env.DBUS_SESSION_BUS_ADDRESS;
var m = address.match(/abstract=([^,]+)/);

var readLine = require('../lib/readline.js');
var message  = require('../lib/message.js');

function waitHandshake(stream, prefix, cb) {
  readLine(stream, function(line) {
    console.log(prefix, line.toString());
    if (line.toString().slice(0, 5) == 'BEGIN' || line.toString().slice(0, 2) == 'OK')
      cb();
    else
      waitHandshake(stream, prefix, cb);
  });
}

net.createServer(function(s)
{
    var buff = "";
    var connected = false;
    var cli

    if (process.argv[2] == '--system')
      cli = net.connect('/var/run/dbus/system_bus_socket');
    else
      cli = abs.connect('\0' + m[1]);

    s.on('data', function(d) {
        if (connected)
        {
           cli.write(d);
        } else {
           buff += d.toString();
        }
    });
   // setTimeout(function() {
   //      console.log('CONNECTED!');
        connected = true;
        cli.write(buff);
    //}, 100);
    cli.pipe(s);

    var through2 = require('through2');
    var cc = through2();
    var ss = through2();

    //cli.on('data', function(b) { console.log(hexy(b, {prefix: 'from dbus '})); cc.write(b); });
    //s.on('data', function(b)   { console.log(hexy(b, {prefix: 'from  cli '})); ss.write(b); });

    // TODO: pipe? streams1 and streams2 here
     cli.on('data', function(b) { cc.write(b); });
     s.on('data', function(b)   { ss.write(b); });


    //s.pipe(cli);
    //cli.pipe(s);

    //var Writable = require('stream').Writable
    //var sw = new Writable()
    //sw._write = function (chunk, encoding, cb) {
    //});

    waitHandshake(cc, 'dbus>', function() {
      message.unmarshalMessages(cc, function(message) {
        console.log('dbus>\n', JSON.stringify(message, null, 2));
      });
    });

    waitHandshake(ss, ' cli>', function() {
      message.unmarshalMessages(ss, function(message) {
        console.log(' cli>\n', JSON.stringify(message, null, 2));
      });
    });

}).listen(3334, function() {
  console.log('Server started. connect with DBUS_SESSION_BUS_ADDRESS=tcp:host=127.0.0.1,port=3334');
});

