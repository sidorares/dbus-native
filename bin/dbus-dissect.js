// simple script to monitor incoming/outcoming dbus messages
//
// It listens on a TCP port and proxies everything to the real bus, dumping
// every decoded message from both directions along the way.

const net = require('net');
const { PassThrough } = require('stream');
const { parseArgs } = require('util');
const message = require('../lib/message');
const readLine = require('../lib/readline');

const { values: argv } = parseArgs({
  options: {
    system: { type: 'boolean', default: false },
    port: { type: 'string', default: '3334' }
  }
});

function sessionBusAddress() {
  const address = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!address) {
    throw new Error('DBUS_SESSION_BUS_ADDRESS is not set');
  }
  const abstract = address.match(/abstract=([^,]+)/);
  // Node supports Linux abstract sockets natively by prefixing with a NUL byte.
  if (abstract) return `\0${abstract[1]}`;
  const path = address.match(/path=([^,]+)/);
  if (path) return path[1];
  throw new Error(`Cannot dissect bus address: ${address}`);
}

const address = argv.system
  ? '/var/run/dbus/system_bus_socket'
  : sessionBusAddress();

function waitHandshake(stream, prefix, cb) {
  readLine(stream, line => {
    console.log(prefix, line.toString());
    if (
      line.toString().slice(0, 5) === 'BEGIN' ||
      line.toString().slice(0, 2) === 'OK'
    ) {
      cb();
    } else {
      waitHandshake(stream, prefix, cb);
    }
  });
}

net
  .createServer(s => {
    const cli = net.connect(address);

    s.pipe(cli);
    cli.pipe(s);

    const fromBus = new PassThrough();
    const fromClient = new PassThrough();

    cli.on('data', b => fromBus.write(b));
    s.on('data', b => fromClient.write(b));

    waitHandshake(fromBus, 'dbus>', () => {
      message.unmarshalMessages(fromBus, msg => {
        console.log('dbus>\n', JSON.stringify(msg, null, 2));
      });
    });

    waitHandshake(fromClient, ' cli>', () => {
      message.unmarshalMessages(fromClient, msg => {
        console.log(' cli>\n', JSON.stringify(msg, null, 2));
      });
    });
  })
  .listen(Number(argv.port), () => {
    console.log(
      `Server started. connect with DBUS_SESSION_BUS_ADDRESS=tcp:host=127.0.0.1,port=${argv.port}`
    );
  });
