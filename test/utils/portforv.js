var net = require('net');
var hexy = require('./lib/hexy').hexy;
require('abstractsocket')(net);

net.createServer(function(s)
{
    console.log('connection!');
    var buff = "";
    var connected = false;
    //var cli = net.createConnection('/var/run/dbus/system_bus_socket');
    var cli  = net.createConnection("\0/tmp/dbus-0PpuqHgmcw");
    s.on('data', function(d) {
        console.log('');
        var len = d.length;
        console.log('length: ' + len + ' ' + len.toString(16));
        console.error(hexy(d, {prefix: 'from client'}));
        if (connected)
        {
           cli.write(d);
        } else {
           buff += d.toString();
        }
    });
    s.on('end', function() {
        cli.end();
        connected = false;
    });
    cli.on('end', function() {
        connected = false;
        console.log('client disconnected');
    });
    cli.on('data', function(d) {
        console.log('');
        var len = d.length;
        console.log('length: ' + len + ' ' + len.toString(16));
        console.error(hexy(d, {prefix: 'from bus   '}));
    });
    cli.on('connect', function() {
        //console.log('connected to 3000');
        connected = true;
        cli.write(buff);
    });
    cli.pipe(s);
}).listen(7000, '0.0.0.0');

