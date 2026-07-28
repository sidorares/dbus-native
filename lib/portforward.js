// Expose a unix/abstract session bus over TCP, dumping traffic as it goes.
// Handy when you want to point a remote (or containerised) client at the bus
// running on this machine.

const net = require('net');
const { hexy } = require('hexy');

const address = process.env.DBUS_SESSION_BUS_ADDRESS;
if (!address) throw new Error('DBUS_SESSION_BUS_ADDRESS is not set');

const abstract = address.match(/abstract=([^,]+)/);
const unixPath = address.match(/path=([^,]+)/);
// Node supports Linux abstract sockets natively by prefixing with a NUL byte.
const busPath = abstract ? `\0${abstract[1]}` : unixPath && unixPath[1];
if (!busPath) throw new Error(`Cannot forward bus address: ${address}`);

net
  .createServer(s => {
    const cli = net.connect(busPath);

    s.pipe(cli);
    cli.pipe(s);

    cli.on('data', b => {
      console.log(hexy(b, { prefix: 'from server ' }));
    });
    s.on('data', b => {
      console.log(hexy(b, { prefix: 'from client ' }));
    });
  })
  .listen(3334, () => {
    console.log(
      'Server started. connect with DBUS_SESSION_BUS_ADDRESS=tcp:host=127.0.0.1,port=3334'
    );
  });
