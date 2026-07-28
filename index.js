// dbus.freedesktop.org/doc/dbus-specification.html

const { EventEmitter } = require('events');
const net = require('net');
const { spawn } = require('child_process');
const { Duplex } = require('stream');

const constants = require('./lib/constants');
const message = require('./lib/message');
const clientHandshake = require('./lib/handshake');
const serverHandshake = require('./lib/server-handshake');
const MessageBus = require('./lib/bus');
const server = require('./lib/server');

// A d-bus address is `family:key=value,key=value`, and DBUS_SESSION_BUS_ADDRESS
// may hold several of them separated by `;`. See
// https://dbus.freedesktop.org/doc/dbus-specification.html#addresses
function parseAddressParams(address) {
  const [family, paramString = ''] = address.split(':');
  const params = {};
  for (const pair of paramString.split(',')) {
    if (!pair) continue;
    const [key, value] = pair.split('=');
    params[key] = value;
  }
  return { family: family.toLowerCase(), params };
}

function connectToAddress(address) {
  const { family, params } = parseAddressParams(address);

  switch (family) {
    case 'tcp':
      return net.createConnection(params.port, params.host || 'localhost');
    case 'unix':
      if (params.socket) return net.createConnection(params.socket);
      if (params.abstract) {
        // Node supports Linux abstract sockets natively since v20.8.0 by
        // prefixing the path with a NUL byte - no native addon required.
        return net.createConnection(`\0${params.abstract}`);
      }
      if (params.path) return net.createConnection(params.path);
      throw new Error(
        "not enough parameters for 'unix' connection - you need to specify 'socket' or 'abstract' or 'path' parameter"
      );
    case 'unixexec': {
      const args = [];
      for (let n = 1; params[`arg${n}`]; n++) args.push(params[`arg${n}`]);
      const child = spawn(params.path, args);
      return Duplex.from({ writable: child.stdin, readable: child.stdout });
    }
    default:
      throw new Error(`unknown address type:${family}`);
  }
}

function createStream(opts) {
  if (opts.stream) return opts.stream;
  const { host, port, socket } = opts;
  if (socket) return net.createConnection(socket);
  if (port) return net.createConnection(port, host);

  const busAddress = opts.busAddress || process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!busAddress) throw new Error('unknown bus address');

  const addresses = busAddress.split(';');
  for (let i = 0; i < addresses.length; ++i) {
    try {
      return connectToAddress(addresses[i]);
    } catch (e) {
      if (i === addresses.length - 1) throw e;
      console.warn(e.message);
    }
  }
}

function createConnection(opts) {
  const self = new EventEmitter();
  if (!opts) opts = {};
  const stream = (self.stream = createStream(opts));
  stream.setNoDelay?.();

  // Set once we have reported a fatal protocol error and torn the stream
  // down ourselves, so the teardown does not surface as a second error.
  let fatal = false;

  stream.on('error', err => {
    // forward network and stream errors
    if (fatal) return;
    self.emit('error', err);
  });

  stream.on('end', () => {
    self.emit('end');
    self.message = () => {
      console.warn("Didn't write bytes to closed stream");
    };
  });

  self.end = () => {
    stream.end();
    return self;
  };

  const handshake = opts.server ? serverHandshake : clientHandshake;
  handshake(stream, opts, (error, guid) => {
    if (error) {
      return self.emit('error', error);
    }
    self.guid = guid;
    self.emit('connect');
    message.unmarshalMessages(
      stream,
      msg => {
        self.emit('message', msg);
      },
      opts,
      err => {
        // Framing is unrecoverable: we no longer know where the next message
        // starts, so surface the error and drop the connection rather than
        // resynchronising on garbage.
        self.emit('error', err);
        fatal = true;
        stream.destroy();
      }
    );
  });

  self._messages = [];

  // pre-connect version, buffers all messages. replaced after connect
  self.message = msg => {
    self._messages.push(msg);
  };

  self.once('connect', () => {
    self.state = 'connected';
    for (const msg of self._messages) {
      stream.write(message.marshall(msg));
    }
    self._messages.length = 0;

    // no need to buffer once connected
    self.message = msg => {
      stream.write(message.marshall(msg));
    };
  });

  return self;
}

module.exports.createClient = function (params) {
  const connection = createConnection(params || {});
  return new MessageBus(connection, params || {});
};

module.exports.systemBus = function () {
  return module.exports.createClient({
    busAddress:
      process.env.DBUS_SYSTEM_BUS_ADDRESS ||
      'unix:path=/var/run/dbus/system_bus_socket'
  });
};

module.exports.sessionBus = function (opts) {
  return module.exports.createClient(opts);
};

module.exports.messageType = constants.messageType;
module.exports.createConnection = createConnection;

module.exports.createServer = server.createServer;
