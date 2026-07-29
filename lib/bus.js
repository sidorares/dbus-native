const EventEmitter = require('events').EventEmitter;
const constants = require('./constants');
const stdDbusIfaces = require('./stdifaces');
const introspect = require('./introspect').introspectBus;
const { maybePromise } = require('./promisify');
const { assertValidName } = require('./names');
const {
  TimeoutError,
  AbortError,
  ConnectionClosedError,
  UnknownInterfaceError,
  fromReply
} = require('./errors');
const { channels } = require('./diagnostics');
const {
  declaration: propertyDeclaration,
  changedSignal: propertiesChangedSignal
} = require('./properties');

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

  /**
   * Take the next message serial.
   *
   * The serial is a uint32 in the header, and this used to be a bare `++` with
   * nothing to stop it: past 4294967295 the marshaller rejected every outgoing
   * message with `Number outside range`, and the connection was dead for good.
   * At a thousand messages a second that is about fifty days, which is well
   * within the life of the long-running daemons this library is used for.
   *
   * Zero is not a valid serial, so the wrap goes back to 1.
   *
   * A wrap could in principle land on the serial of a call that is still
   * outstanding, but that call would have to have been pending across 2^32
   * messages -- and since 0.6 there are timeouts. libdbus wraps on the same
   * reasoning.
   */
  this.nextSerial = function () {
    const serial = self.serial;
    self.serial = serial >= 0xffffffff ? 1 : serial + 1;
    return serial;
  };

  // Until 0.7 a connection that went away took its pending callbacks with it:
  // the socket closed, `cookies` was discarded, and anyone waiting on a reply
  // waited forever. That is #39, and what PR #213 set out to fix.
  //
  // Note this listens for 'close'/'end' and never for 'error'. Attaching an
  // 'error' listener here would stop an unhandled connection error from
  // crashing the process, which is not ours to decide.
  let closed = false;
  function failPendingCalls(cause) {
    if (closed) return;
    closed = true;
    const pending = self.cookies;
    self.cookies = {};
    for (const serial of Object.keys(pending)) {
      const settle = pending[serial];
      settle(new ConnectionClosedError(settle.msg || {}, cause));
    }
  }
  conn.on('close', failPendingCalls);
  conn.on('end', () => failPendingCalls());

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

      // Writing to a closed connection used to warn and return false, leaving
      // the caller waiting on a reply that could not arrive.
      if (closed) {
        return cb(new ConnectionClosedError(msg));
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
      msg.serial = self.nextSerial();
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

      // Kept on the cookie so a connection teardown can say which call it
      // failed, rather than just "the connection closed".
      settle.msg = msg;
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
    // A signal gets no reply, so an unroutable one fails silently -- unlike a
    // method call, where the daemon or the peer would tell you. The path goes
    // through the 'o' marshaller, which validates it; these two do not.
    assertValidName('interface name', iface, 'the signal interface');
    assertValidName('member name', name, 'the signal name');
    const signalMsg = {
      type: constants.messageType.signal,
      serial: self.nextSerial(),
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

  /**
   * Announce that exported properties changed.
   *
   * `Properties.Set` calls this for you. Call it yourself when the service
   * changes a property on its own -- assigning to `impl.Greeting` is an
   * ordinary property write and there is no way to observe it without
   * redefining the accessor, which would be a surprising thing for exporting
   * an object to do to it.
   *
   *   bus.emitPropertiesChanged('/com/example/Obj', 'com.example.Iface', {
   *     Greeting: 'hello again'
   *   });
   *
   * `invalidated` names properties whose value changed but is not being
   * broadcast -- write-only ones, or anything expensive to compute. Listing
   * them is what tells a subscriber to re-read rather than keep a stale value.
   *
   * Signatures come from the interface descriptor, so the values are marshalled
   * as the interface declares them rather than guessed from the JS type.
   */
  this.emitPropertiesChanged = function (
    path,
    interfaceName,
    changed,
    invalidated
  ) {
    const entry = self.exportedObjects[path];
    const iface = entry && entry[interfaceName] && entry[interfaceName][0];
    if (!iface) {
      throw new Error(
        `No interface "${interfaceName}" exported at object path "${path}"`
      );
    }
    const changedEntries = Object.keys(changed || {}).map(name => {
      const decl = propertyDeclaration(iface, name);
      if (!decl) {
        throw new Error(
          `No such property "${name}" on interface "${interfaceName}"`
        );
      }
      return [name, [decl.type, changed[name]]];
    });
    self.connection.message(
      propertiesChangedSignal(
        self.nextSerial(),
        path,
        interfaceName,
        changedEntries,
        invalidated || []
      )
    );
  };

  this.sendError = function (msg, errorName, errorText) {
    // Error names follow the interface-name rules. An invalid one is a
    // protocol violation the peer cannot route, so it is better to fail here
    // than to put it on the wire.
    assertValidName('error name', errorName);
    const reply = {
      type: constants.messageType.error,
      serial: self.nextSerial(),
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
      serial: self.nextSerial(),
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
              serial: self.nextSerial(),
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
        if (msg.type === constants.messageType.methodReturn) {
          // body as array of arguments, no error
          handler.apply(props, [null].concat(msg.body || []));
        } else {
          // Since 0.7 this is a DBusError rather than the raw body array. The
          // body is still on it as `err.body`. See docs/migrating-to-0.7.md.
          handler.call(props, fromReply(msg));
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
    // Checked here rather than at the first method call: an object exported
    // under a name a peer cannot route to is unreachable, and the useful place
    // to say so is where the mistake was made.
    assertValidName('object path', path);
    assertValidName('interface name', iface.name, 'the interface descriptor');
    for (const kind of ['methods', 'signals', 'properties']) {
      for (const member of Object.keys(iface[kind] || {})) {
        assertValidName('member name', member, `${kind}.${member}`);
      }
    }

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
            serial: self.nextSerial(),
            interface: iface.name,
            path,
            member: signalName
          };
          if (signal[0]) {
            signalMsg.signature = signal[0];
            signalMsg.body = args.slice(1);
          }
          self.connection.message(signalMsg);
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
      // A connection that died before Hello completed has already said so
      // through its own 'error'/'end' events; throwing again here would turn
      // an ordinary early close into an uncaught exception.
      if (err && err.code === 'ECONNCLOSED') return;
      if (err) throw err;
      self.name = name;
    });
  } else {
    self.name = null;
  }

  function DBusObject(name, service) {
    this.name = name;
    this.service = service;
    // Until 0.7 this returned undefined for an interface the object does not
    // implement, so the mistake surfaced later as a property access on
    // undefined, somewhere unrelated to the typo that caused it -- #208.
    this.as = function (ifaceName) {
      const iface = this.proxy[ifaceName];
      if (!iface)
        throw new UnknownInterfaceError(
          ifaceName,
          this.name,
          this.service && this.service.name,
          Object.keys(this.proxy)
        );
      return iface;
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
          let iface;
          try {
            iface = obj.as(ifaceName);
          } catch (e) {
            return cb(e);
          }
          cb(null, iface);
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
        let iface;
        try {
          iface = obj.as(name);
        } catch (e) {
          return cb(e);
        }
        cb(null, iface);
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
