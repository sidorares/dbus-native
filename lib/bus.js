const EventEmitter = require('events').EventEmitter;
const constants = require('./constants');
const stdDbusIfaces = require('./stdifaces');
const introspect = require('./introspect').introspectBus;
const { maybePromise } = require('./promisify');
const { TimeoutError, AbortError } = require('./errors');
const { channels } = require('./diagnostics');

// A failed call currently delivers the raw message body -- an array, or `[]`
// when the body is empty. In 1.0 that becomes a DBusError. Attaching the
// properties it will have lets callers write `err.dbusName` / `err.message`
// today and keep working across that change unmodified. See
// docs/deprecations.md#dbus_dep0004.
//
// Non-enumerable, so JSON.stringify(err) and deepStrictEqual are unchanged for
// anyone relying on the array shape until 1.0.
function decorateError(body, msg) {
  const message =
    (typeof body[0] === 'string' && body[0]) ||
    msg.errorName ||
    'D-Bus error with no message';
  for (const [key, value] of Object.entries({
    name: 'DBusError',
    message,
    dbusName: msg.errorName,
    reply: msg
  })) {
    Object.defineProperty(body, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: true
    });
  }
  return body;
}

module.exports = function bus(conn, opts) {
  if (!(this instanceof bus)) {
    return new bus(conn);
  }
  if (!opts) opts = {};

  const self = this;
  // Opt-in per-client default; undefined means wait forever, as before.
  const defaultTimeout = opts.timeout;
  this.connection = conn;
  this.serial = 1;
  this.cookies = {}; // TODO: rename to methodReturnHandlers
  this.methodCallHandlers = {};
  this.signals = new EventEmitter();
  this.exportedObjects = {};

  // Returns a promise when no callback is given; the callback path is
  // unchanged. See lib/promisify.js.
  // invoke(msg, callback)
  // invoke(msg, { signal, timeout })            -> promise
  // invoke(msg, { signal, timeout }, callback)
  this.invoke = function (msg, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    const opts = options || {};
    const signal = opts.signal;
    // No default timeout unless the client asked for one. Making calls that
    // currently hang start failing is a behaviour change, and belongs in a
    // major -- see RELEASE_PLAN.md.
    const timeout = opts.timeout !== undefined ? opts.timeout : defaultTimeout;

    return maybePromise(callback, cb => {
      if (signal && signal.aborted) {
        // Never put it on the wire in the first place.
        return cb(new AbortError(signal, msg));
      }

      // Only pay for the context object when something is listening.
      const traced = channels.call.hasSubscribers;
      const context = traced
        ? {
            destination: msg.destination,
            path: msg.path,
            interface: msg['interface'],
            member: msg.member,
            signature: msg.signature
          }
        : null;
      if (traced) channels.call.start.publish(context);

      if (!msg.type) msg.type = constants.messageType.methodCall;
      msg.serial = self.serial++;
      const serial = msg.serial;

      let timer = null;
      let onAbort = null;
      let settled = false;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
        delete self.cookies[serial];
      };

      // Whichever of reply, timeout or abort happens first wins; the rest are
      // torn down. Removing the cookie is what stops `bus.cookies` growing for
      // every call that never gets an answer.
      function settle(err, ...values) {
        if (settled) return;
        settled = true;
        cleanup();
        if (traced) {
          if (err) {
            context.error = err;
            channels.call.error.publish(context);
          } else {
            context.result = values.length === 1 ? values[0] : values;
          }
          channels.call.end.publish(context);
        }
        cb.apply(this, [err, ...values]);
      }

      self.cookies[serial] = settle;

      if (timeout > 0) {
        timer = setTimeout(
          () => settle(new TimeoutError(timeout, msg)),
          timeout
        );
        // A pending call should not hold the process open on its own; the
        // connection's socket already does that while it is alive.
        if (typeof timer.unref === 'function') timer.unref();
      }

      if (signal) {
        onAbort = () => settle(new AbortError(signal, msg));
        signal.addEventListener('abort', onAbort, { once: true });
      }

      self.connection.message(msg);
    });
  };

  this.invokeDbus = function (msg, options, callback) {
    if (!msg.path) msg.path = '/org/freedesktop/DBus';
    if (!msg.destination) msg.destination = 'org.freedesktop.DBus';
    if (!msg['interface']) msg['interface'] = 'org.freedesktop.DBus';
    return self.invoke(msg, options, callback);
  };

  this.mangle = function (path, iface, member) {
    const obj = {};
    if (typeof path === 'object') {
      // handle one argument case mangle(msg)
      obj.path = path.path;
      obj['interface'] = path['interface'];
      obj.member = path.member;
    } else {
      obj.path = path;
      obj['interface'] = iface;
      obj.member = member;
    }
    return JSON.stringify(obj);
  };

  this.sendSignal = function (path, iface, name, signature, args) {
    const signalMsg = {
      type: constants.messageType.signal,
      serial: self.serial++,
      interface: iface,
      path,
      member: name
    };
    if (signature) {
      signalMsg.signature = signature;
      signalMsg.body = args;
    }
    self.connection.message(signalMsg);
  };

  // Warning: errorName must respect the same rules as interface names (must contain a dot)
  this.sendError = function (msg, errorName, errorText) {
    const reply = {
      type: constants.messageType.error,
      serial: self.serial++,
      replySerial: msg.serial,
      destination: msg.sender,
      errorName,
      signature: 's',
      body: [errorText]
    };
    this.connection.message(reply);
  };

  this.sendReply = function (msg, signature, body) {
    const reply = {
      type: constants.messageType.methodReturn,
      serial: self.serial++,
      replySerial: msg.serial,
      destination: msg.sender,
      signature,
      body
    };
    this.connection.message(reply);
  };

  // route reply/error
  this.connection.on('message', msg => {
    function invoke(impl, func, resultSignature) {
      Promise.resolve()
        .then(() => {
          return func.apply(impl, (msg.body || []).concat(msg));
        })
        .then(
          methodReturnResult => {
            const methodReturnReply = {
              type: constants.messageType.methodReturn,
              serial: self.serial++,
              destination: msg.sender,
              replySerial: msg.serial
            };
            if (methodReturnResult !== null) {
              methodReturnReply.signature = resultSignature;
              methodReturnReply.body = [methodReturnResult];
            }
            self.connection.message(methodReturnReply);
          },
          e => {
            self.sendError(
              msg,
              e.dbusName || 'org.freedesktop.DBus.Error.Failed',
              e.message || ''
            );
          }
        );
    }

    let handler;
    if (
      msg.type === constants.messageType.methodReturn ||
      msg.type === constants.messageType.error
    ) {
      handler = self.cookies[msg.replySerial];
      if (handler) {
        delete self.cookies[msg.replySerial];
        const props = {
          connection: self.connection,
          bus: self,
          message: msg,
          signature: msg.signature
        };
        let args = msg.body || [];
        if (msg.type === constants.messageType.methodReturn) {
          args = [null].concat(args); // first argument - no errors, null
          handler.apply(props, args); // body as array of arguments
        } else {
          handler.call(props, decorateError(args, msg)); // body as first argument
        }
      }
    } else if (msg.type === constants.messageType.signal) {
      self.signals.emit(self.mangle(msg), msg.body, msg.signature);
    } else {
      // methodCall

      if (stdDbusIfaces(msg, self)) return;

      // exported interfaces handlers
      let obj, iface, impl;
      if ((obj = self.exportedObjects[msg.path])) {
        if ((iface = obj[msg['interface']])) {
          // now we are ready to serve msg.member
          impl = iface[1];
          const func = impl[msg.member];
          if (!func) {
            self.sendError(
              msg,
              'org.freedesktop.DBus.Error.UnknownMethod',
              `Method "${msg.member}" on interface "${
                msg.interface
              }" doesn't exist`
            );
            return;
          }
          // TODO safety check here
          const resultSignature = iface[0].methods[msg.member][1];
          invoke(impl, func, resultSignature);
          return;
        } else {
          self.sendError(
            msg,
            'org.freedesktop.DBus.Error.UnknownInterface',
            `No such interface "${msg['interface']}" at object path "${msg.path}"`
          );
          return;
        }
      }
      // setMethodCall handlers
      handler = self.methodCallHandlers[self.mangle(msg)];
      if (handler) {
        invoke(null, handler[0], handler[1]);
      } else {
        self.sendError(
          msg,
          'org.freedesktop.DBus.Error.UnknownMethod',
          `No handler for "${msg.member}" on interface "${msg['interface']}" at object path "${msg.path}"`
        );
      }
    }
  });

  this.setMethodCallHandler = function (objectPath, iface, member, handler) {
    const key = self.mangle(objectPath, iface, member);
    self.methodCallHandlers[key] = handler;
  };

  this.exportInterface = function (obj, path, iface) {
    let entry;
    if (!self.exportedObjects[path]) {
      entry = self.exportedObjects[path] = {};
    } else {
      entry = self.exportedObjects[path];
    }
    entry[iface.name] = [iface, obj];
    // monkey-patch obj.emit()
    if (typeof obj.emit === 'function') {
      const oldEmit = obj.emit;
      obj.emit = function () {
        const args = Array.prototype.slice.apply(arguments);
        const signalName = args[0];
        if (!signalName) throw new Error('Trying to emit undefined signal');

        //send signal to bus
        let signal;
        if (iface.signals && iface.signals[signalName]) {
          signal = iface.signals[signalName];
          const signalMsg = {
            type: constants.messageType.signal,
            serial: self.serial++,
            interface: iface.name,
            path,
            member: signalName
          };
          if (signal[0]) {
            signalMsg.signature = signal[0];
            signalMsg.body = args.slice(1);
          }
          self.connection.message(signalMsg);
          self.serial++;
        }
        // note that local emit is likely to be called before signal arrives
        // to remote subscriber
        oldEmit.apply(obj, args);
      };
    }
    // TODO: emit ObjectManager's InterfaceAdded
  };

  // register name
  if (opts.direct !== true) {
    this.invokeDbus({ member: 'Hello' }, (err, name) => {
      if (err) throw new Error(err);
      self.name = name;
    });
  } else {
    self.name = null;
  }

  function DBusObject(name, service) {
    this.name = name;
    this.service = service;
    this.as = function (name) {
      return this.proxy[name];
    };
  }

  function DBusService(name, bus) {
    this.name = name;
    this.bus = bus;
    this.getObject = function (name, callback) {
      return maybePromise(callback, cb => {
        if (name === undefined)
          return cb(new Error('Object name is null or undefined'));
        const obj = new DBusObject(name, this);
        introspect(obj, (err, ifaces, nodes) => {
          if (err) return cb(err);
          obj.proxy = ifaces;
          obj.nodes = nodes;
          cb(null, obj);
        });
      });
    };

    this.getInterface = function (objName, ifaceName, callback) {
      return maybePromise(callback, cb => {
        this.getObject(objName, (err, obj) => {
          if (err) return cb(err);
          cb(null, obj.as(ifaceName));
        });
      });
    };
  }

  this.getService = function (name) {
    return new DBusService(name, this);
  };

  this.getObject = function (path, name, callback) {
    const service = this.getService(path);
    return service.getObject(name, callback);
  };

  this.getInterface = function (path, objname, name, callback) {
    return maybePromise(callback, cb => {
      this.getObject(path, objname, (err, obj) => {
        if (err) return cb(err);
        cb(null, obj.as(name));
      });
    });
  };

  // TODO: refactor

  // bus meta functions
  this.addMatch = function (match, callback) {
    return this.invokeDbus(
      { member: 'AddMatch', signature: 's', body: [match] },
      callback
    );
  };

  this.removeMatch = function (match, callback) {
    return this.invokeDbus(
      { member: 'RemoveMatch', signature: 's', body: [match] },
      callback
    );
  };

  this.getId = function (callback) {
    return this.invokeDbus({ member: 'GetId' }, callback);
  };

  this.requestName = function (name, flags, callback) {
    return this.invokeDbus(
      { member: 'RequestName', signature: 'su', body: [name, flags] },
      callback
    );
  };

  this.releaseName = function (name, callback) {
    return this.invokeDbus(
      { member: 'ReleaseName', signature: 's', body: [name] },
      callback
    );
  };

  this.listNames = function (callback) {
    return this.invokeDbus({ member: 'ListNames' }, callback);
  };

  this.listActivatableNames = function (callback) {
    return this.invokeDbus({ member: 'ListActivatableNames' }, callback);
  };

  this.updateActivationEnvironment = function (env, callback) {
    return this.invokeDbus(
      {
        member: 'UpdateActivationEnvironment',
        signature: 'a{ss}',
        body: [env]
      },
      callback
    );
  };

  this.startServiceByName = function (name, flags, callback) {
    return this.invokeDbus(
      { member: 'StartServiceByName', signature: 'su', body: [name, flags] },
      callback
    );
  };

  this.getConnectionUnixUser = function (name, callback) {
    return this.invokeDbus(
      { member: 'GetConnectionUnixUser', signature: 's', body: [name] },
      callback
    );
  };

  this.getConnectionUnixProcessId = function (name, callback) {
    return this.invokeDbus(
      { member: 'GetConnectionUnixProcessID', signature: 's', body: [name] },
      callback
    );
  };

  this.getNameOwner = function (name, callback) {
    return this.invokeDbus(
      { member: 'GetNameOwner', signature: 's', body: [name] },
      callback
    );
  };

  this.nameHasOwner = function (name, callback) {
    return this.invokeDbus(
      { member: 'NameHasOwner', signature: 's', body: [name] },
      callback
    );
  };
};
