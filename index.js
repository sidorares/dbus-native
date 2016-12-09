// dbus.freedesktop.org/doc/dbus-specification.html

const net                = require ('net')
const utils              = require ('./lib/utils')
const inspect            = require ('util').inspect
const message            = require ('./lib/message')
const constants          = require ('./lib/constants')
const DBusProxy          = require ('./lib/DBusProxy.js')
const signature          = require ('./lib/signature.js')
const DBusService        = require ('./lib/DBusService.js')
const EventEmitter       = require ('events').EventEmitter
const helloMessage       = require ('./lib/hello-message.js')
const DBusObjectLibs     = require ('./lib/DBusObjectLibs')
const clientHandshake    = require ('./lib/handshake.js')
const serverHandshake    = require ('./lib/server-handshake.js')
const DBusInterfaceLibs  = require ('./lib/DBusInterfaceLibs')

// Whether to set this file's functions into debugging (verbose) mode
const DEBUG_THIS_FILE = false

// Allows for setting all files to debug in once statement instead of manually setting every flag
const DEBUG = DEBUG_THIS_FILE || utils.GLOBAL_DEBUG


function createStream(opts) {
  if (opts.stream)
    return opts.stream;
  var host = opts.host;
  var port = opts.port;
  var socket = opts.socket;
  var stream;
  if (socket)
    return net.createConnection(socket);
  if (port)
    return net.createConnection(port, host);

  var busAddress = opts.busAddress || process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!busAddress) throw new Error('unknown bus address');

  var addresses = busAddress.split(';')
  for (var i in addresses) {
    var address = addresses[i];
    var familyParams = address.split(':');
    var family = familyParams[0];
    var params = {};
    familyParams[1].split(',').map(function(p) {
      var keyVal = p.split('=');
      params[keyVal[0]] = keyVal[1];
    });

    try {

      switch (family.toLowerCase()) {
        case 'tcp':
          host = params.host || 'localhost';
          port = params.port;
          return net.createConnection(port, host);
        case 'unix':
          if (params.socket)
            return net.createConnection(params.socket);
          if (params.abstract) {
            var abs = require('abstract-socket');
            return abs.connect('\u0000' + params.abstract);
          }
          if (params.path)
            return net.createConnection(params.path);
          throw new Error('not enough parameters for \'unix\' connection - you need to specify \'socket\' or \'abstract\' or \'path\' parameter');
        case 'unixexec':
          var eventStream = require('event-stream');
          var spawn = require('child_process').spawn;
          var args = [];
          for (var n = 1; params['arg' + n]; n++)
            args.push(params['arg' + n]);
          spawn(params.path, args);
          return eventStream.duplex(child.stdin, child.stdout);
        default:
          throw new Error('unknown address type:' + family);
      }

    } catch (e) {

      if (i < addresses.length - 1) {
        if (console && console.warn instanceof Function) console.warn(e.message);
        continue;
      } else {
        throw e;
      }

    }
  }

}

function createConnection(opts) {
  var self = new EventEmitter();
  if (!opts) opts = {};
  var stream = self.stream = createStream(opts);
  stream.setNoDelay();

  stream.on('error', function(err) {
      if (DEBUG) console.error ('Stream.error(): ' + err)
    // forward network and stream errors
    self.emit('error', err);
  });

  stream.on('end', function() {
    if (DEBUG) console.error ('Stream.end(): ' + inspect (arguments))
    self.emit('end');
    self.message = function() {
      console.warn("Didn't write bytes to closed stream");
    };
  });

  self.end = function() {
    stream.end();
    return self;
  };

  var handshake = opts.server ? serverHandshake : clientHandshake;
  handshake(stream, opts, function(error, guid) {
    if (error) {
      return self.emit('error');
    }
    self.guid = guid;
    self.emit('connect');
    message.unmarshalMessages(stream, function(message) {
      self.emit('message', message);
    });
  });

  self._messages = [];

  // pre-connect version, buffers all messages. replaced after connect
  self.message = function(msg) {
    self._messages.push(msg);
  };

  self.once('connect', function() {
    self.state = 'connected';
    for (var i = 0; i < self._messages.length; ++i) {
       stream.write(message.marshall(self._messages[i]));
    }
    self._messages.length = 0;

    // no need to buffer once connected
    self.message = function(msg) {
      stream.write(message.marshall(msg));
    };
  });

  return self;
};

var MessageBus = require('./lib/bus.js');

module.exports = createConnection;

module.exports.createClient = function(params) {
  var connection = createConnection(params || {});
  return new MessageBus(connection, params || {});
};

module.exports.systemBus = function() {
  return module.exports.createClient({
    socket: '/var/run/dbus/system_bus_socket'
  });
};

module.exports.sessionBus = function(opts) {
  return module.exports.createClient(opts);
};

module.exports.messageType = constants.messageType;
module.exports.createConnection = module.exports;

var server = require('./lib/server.js');
module.exports.createServer = server.createServer;

/*
    Export DBus signature types
*/

let type = {}

type.DBUS_BYTE = signature.DBUS_BYTE
type.DBUS_BOOL = signature.DBUS_BOOL
type.DBUS_INT16 = signature.DBUS_INT16
type.DBUS_UINT16 = signature.DBUS_UINT16
type.DBUS_INT32 = signature.DBUS_INT32
type.DBUS_UINT32 = signature.DBUS_UINT32
type.DBUS_INT64 = signature.DBUS_INT64
type.DBUS_UINT64 = signature.DBUS_UINT64
type.DBUS_DOUBLE = signature.DBUS_DOUBLE
type.DBUS_UNIX_FD = signature.DBUS_UNIX_FD
type.DBUS_STRING = signature.DBUS_STRING
type.DBUS_OBJ_PATH = signature.DBUS_OBJ_PATH
type.DBUS_SIGNATURE = signature.DBUS_SIGNATURE
type.DBUS_VARIANT = signature.DBUS_VARIANT

type.DBUS_ARRAY = signature.DBUS_ARRAY
type.DBUS_DICT = signature.DBUS_DICT
type.DBUS_STRUCT = signature.DBUS_STRUCT

module.exports.type = type

/*
    Exports classes from the new API
*/

module.exports.DBusObjectLibs = DBusObjectLibs
module.exports.DBusInterfaceLibs = DBusInterfaceLibs
module.exports.DBusService = DBusService
module.exports.DBusProxy = DBusProxy
