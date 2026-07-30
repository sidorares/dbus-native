const EventEmitter = require('events').EventEmitter;
const constants = require('./constants');

const DBUS_NAME = 'org.freedesktop.DBus';

/** ms a call waits for its reply. What libdbus, GDBus and sd-bus all use. */
const DEFAULT_TIMEOUT = 25000;
const stdDbusIfaces = require('./stdifaces');
const introspect = require('./introspect').introspectBus;
const { maybePromise } = require('./promisify');
const { assertValidName } = require('./names');
const parseSignature = require('./signature');
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
const objectManager = require('./object-manager');

function bus(conn, opts) {
  if (!(this instanceof bus)) {
    // `opts` has to be forwarded: without it `bus(conn, { direct: true })`
    // built a bus that ignored every option it was given and sent Hello to a
    // peer with no bus behind it.
    return new bus(conn, opts);
  }
  if (!opts) opts = {};
  // An EventEmitter so the bus can report things that are its own rather than
  // the transport's -- 'reconnected' is about names and match rules, which the
  // connection knows nothing about. Purely additive: nothing here was called
  // `on`, `emit` or any of the rest.
  EventEmitter.call(this);

  const self = this;
  // Every call gets a deadline unless one is turned off explicitly, with
  // `timeout: 0` per client or per call.
  //
  // A call that never gets a reply used to wait for the process to end, which
  // is not a thing a caller can recover from or even see: the promise simply
  // never settles. Any peer can cause it -- by crashing between receiving the
  // message and answering it, or by having a handler that silently returns
  // without replying -- so "wait forever" makes one program's bug into
  // another's hang.
  //
  // 25 seconds because that is what libdbus, GDBus and sd-bus all use, so a
  // call that hits this deadline would have hit theirs at the same point. A
  // caller that genuinely needs longer says so, exactly as it would there.
  const defaultTimeout =
    opts.timeout !== undefined ? opts.timeout : DEFAULT_TIMEOUT;
  this.connection = conn;
  this.serial = 1;
  this.cookies = {}; // TODO: rename to methodReturnHandlers
  this.methodCallHandlers = {};
  this.signals = new EventEmitter();
  // Keyed by a path that arrives in a message from someone else, so it must
  // not inherit anything: `exportedObjects['__proto__']` on a plain object is
  // Object.prototype, which is truthy, and dispatch then reads an interface
  // off it and calls a member of undefined. A remote peer could stop the
  // process with one malformed method call. Same for the per-path map below,
  // which is keyed by interface name.
  this.exportedObjects = Object.create(null);
  /**
   * Well-known names this connection owns. Not the unique name -- that is
   * assigned rather than owned, and lives on `bus.name`.
   *
   * Used to tell a method call meant for us from one we are merely
   * overhearing. Kept current from the NameAcquired and NameLost signals
   * alone, which is enough: the daemon sends them to the connection concerned
   * unprompted, and it emits NameAcquired while handling RequestName -- before
   * any other client can learn the name has an owner, and therefore before any
   * call to it can be routed here. Messages are processed in arrival order, so
   * there is no window.
   *
   * Reading it from the RequestName reply as well would be redundant, and
   * would have to reach inside the lazy promise `invokeDbus` returns.
   */
  this.names = new Set();

  /**
   * Match rules added through `addMatch`, so a reconnect can put them back.
   *
   * A rule installed by calling `invokeDbus({ member: 'AddMatch' })` directly
   * is not in here and will not survive one -- there is nothing to notice it.
   */
  this.matchRules = new Set();

  /**
   * Is this message addressed to us?
   *
   * Only a bus connection can be handed somebody else's mail, and only once it
   * has a unique name of its own to compare against -- so a peer-to-peer or
   * pre-Hello connection answers everything, exactly as before.
   */
  function addressedToUs(msg) {
    if (!msg.destination) return true;
    if (!self.name) return true;
    return msg.destination === self.name || self.names.has(msg.destination);
  }
  // Paths serving org.freedesktop.DBus.ObjectManager, in export order.
  this.objectManagers = new Set();

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
  // Reset when the transport comes back, or the *second* disconnect would fail
  // nothing and `close()` would resolve without closing anything -- the latch
  // is there to stop one teardown reporting twice, not to make the flag
  // permanent.
  conn.on('reconnect', () => {
    closed = false;
  });

  /**
   * Close the connection, and resolve once it is actually closed.
   *
   * By the time this settles every in-flight call has been failed with
   * `ConnectionClosedError`, rather than left waiting for a reply that cannot
   * arrive. Writes already issued are flushed on the way out: `end()` uncorks
   * the batch `writeMessage` builds, so a signal sent immediately before
   * closing still goes out. Verified rather than assumed.
   *
   * It deliberately does **not** remove match rules or release names first.
   * The bus drops both when the connection goes, so unwinding them by hand
   * would be round trips whose only effect is a slower shutdown. Scope them
   * with `watch()` and `ownName()` when they need to end before the connection
   * does -- that is the case where it matters, and it is a different one.
   *
   * Idempotent, and safe on a connection that has already gone.
   */
  this.close = function () {
    return new Promise(resolve => {
      const stream = conn.stream;
      if (closed || !stream || stream.destroyed) {
        // Resolve on a later tick either way, so a caller racing the teardown
        // does not sometimes get a synchronous answer and sometimes not.
        return setImmediate(resolve);
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      // 'close' is the real signal. 'end' is a fallback for a caller-supplied
      // stream that never emits one -- a PassThrough, say -- which would
      // otherwise hang here forever.
      conn.once('close', done);
      conn.once('end', done);
      conn.end();
    });
  };

  // Lets a connection be scoped: `await using bus = dbus.sessionBus()`.
  // Implemented whatever the consumer's Node version -- only the `using`
  // keyword needs 24, and that is their choice rather than a floor we impose.
  this[Symbol.asyncDispose] = function () {
    return self.close();
  };

  /**
   * Add a match rule, and get something that removes it.
   *
   *     await using sub = await bus.watch("type='signal',interface='...'");
   *
   * This is the resource people forget. A long-lived process that adds match
   * rules and never removes them has the bus deliver steadily more traffic to
   * it, for signals nothing is still listening for.
   */
  this.watch = async function (rule) {
    await self.addMatch(rule);
    let removed = false;
    const subscription = {
      rule,
      get removed() {
        return removed;
      },
      async remove() {
        if (removed) return;
        removed = true;
        // Nothing to remove once the connection has gone -- the bus dropped
        // the rule with it. Checked rather than caught, so a RemoveMatch that
        // fails for any other reason is still reported.
        if (closed) return;
        await self.removeMatch(rule);
      },
      async [Symbol.asyncDispose]() {
        await subscription.remove();
      }
    };
    return subscription;
  };

  /**
   * Request a well-known name, and get something that releases it.
   *
   *     await using reg = await bus.ownName('com.example.Greeter');
   *     if (!reg.isPrimaryOwner) { ... }
   *
   * `result` is the RequestName reply code, because not getting the name is a
   * legitimate outcome rather than an error: 1 primary owner, 2 queued,
   * 3 taken, 4 already ours.
   */
  this.ownName = async function (name, flags = 0) {
    const result = await self.requestName(name, flags);
    let released = false;
    const registration = {
      name,
      result,
      isPrimaryOwner: result === 1,
      get released() {
        return released;
      },
      async release() {
        if (released) return;
        released = true;
        if (closed) return;
        await self.releaseName(name);
      },
      async [Symbol.asyncDispose]() {
        await registration.release();
      }
    };
    return registration;
  };

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

      // NO_REPLY_EXPECTED says the peer must not answer, so there is nothing
      // to wait for and nothing to time out. Settling once the message is
      // written is the only honest answer; registering a cookie against a
      // serial that can never arrive would leak one per call, and arming the
      // deadline would report a TimeoutError for a message that did exactly
      // what it was told.
      if (msg.flags & constants.flags.noReplyExpected) {
        try {
          self.connection.message(msg);
        } catch (err) {
          // Nothing was sent, so the caller needs to hear about it here --
          // there is no pending call for it to surface through later.
          if (traced) {
            context.error = err;
            channels.call.error.publish(context);
            channels.call.end.publish(context);
          }
          return cb(err);
        }
        if (traced) channels.call.end.publish(context);
        return cb(null);
      }

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

      // Marshalling happens inside message(), so a message this connection
      // cannot write -- a malformed object path, a body that does not match
      // its signature -- throws here. It used to throw straight out of
      // invoke() *and* leave the call registered, so the caller got the
      // exception now and a TimeoutError 25 seconds later for a message that
      // never reached the wire. Settle it once, the same way as any other
      // failure.
      try {
        self.connection.message(msg);
      } catch (err) {
        settle(err);
      }
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

  /**
   * Turn what a method handler returned into a reply body.
   *
   * A body is a list of values, one per complete type in the signature. For
   * the usual single-value method that is `[result]`, which is what this
   * always did -- so a declared output of several types could never be
   * satisfied, however the handler returned them. The interface descriptor
   * happily accepts `['', 'si', [], ['name', 'count']]` and the introspection
   * XML advertises two out arguments, so the shape was expressible, promised
   * to callers, and impossible to produce.
   *
   * Several out arguments now mean: return them as an array.
   *
   * Note this is not the same as declaring a struct. `(si)` is one value and
   * still takes `[name, count]` as that one value; `si` is two.
   */
  function replyBody(signature, result) {
    // Cached, and a tiny set in practice -- see lib/signature.js.
    const count = signature ? parseSignature(signature).length : 0;
    if (count <= 1) return [result];
    if (!Array.isArray(result)) {
      throw new Error(
        `an output signature of "${signature}" declares ${count} values, so the handler must return an array of ${count}, not ${typeof result}`
      );
    }
    return result;
  }

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
            // Building or marshalling a reply can fail -- a handler returning
            // the wrong shape for what the interface declares. That used to
            // throw out of this continuation as an unhandled rejection and
            // take the service down, leaving the caller waiting for a reply
            // that would never come. (The two-argument `.then` below does not
            // catch a throw from this handler, which is why the try is here.)
            // Answer with an error instead: the caller learns what happened
            // and the service stays up.
            try {
              if (methodReturnResult !== null) {
                methodReturnReply.signature = resultSignature;
                methodReturnReply.body = replyBody(
                  resultSignature,
                  methodReturnResult
                );
              }
              self.connection.message(methodReturnReply);
            } catch (e) {
              self.sendError(
                msg,
                'org.freedesktop.DBus.Error.Failed',
                `${msg['interface']}.${msg.member} returned a value that does not match its declared output signature "${resultSignature}": ${e.message}`
              );
            }
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
      // NameAcquired and NameLost are sent to the connection concerned whether
      // or not it asked, so tracking them here keeps `self.names` correct with
      // no match rule and no round trip.
      if (
        msg.sender === DBUS_NAME &&
        msg['interface'] === DBUS_NAME &&
        msg.body &&
        typeof msg.body[0] === 'string'
      ) {
        // Well-known names only. NameAcquired fires for the unique name too,
        // but that is assigned rather than owned and `bus.name` already holds
        // it -- keeping it out means `names` means exactly one thing, and that
        // a reconnect never tries to re-request something unrequestable.
        const acquired = msg.body[0];
        if (!acquired.startsWith(':')) {
          if (msg.member === 'NameAcquired') self.names.add(acquired);
          else if (msg.member === 'NameLost') self.names.delete(acquired);
        }
      }
      self.signals.emit(self.mangle(msg), msg.body, msg.signature);
    } else {
      // methodCall

      // Not ours to answer. A match rule with no `type=` -- `''`, or
      // `eavesdrop='true'` -- makes the daemon deliver every message on the
      // bus here, method calls included. Answering one addressed to somebody
      // else sends them an error reply carrying *their* serial, which settles
      // the call they were waiting on with a failure from a process they never
      // spoke to.
      //
      // That is not hypothetical: it is what made this project's own
      // integration suite fail about one run in five, because
      // test/integration/match-rules.js asks the daemon which rules it accepts
      // and those two are in the corpus. See test/integration/eavesdropping.js.
      //
      // Checked before stdDbusIfaces, or an eavesdropper answers Introspect
      // and Properties.Get for other people's objects too.
      if (!addressedToUs(msg)) return;

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

  /**
   * Emitting a signal is done by emitting an ordinary event on the exported
   * object, so `emit` is wrapped to put the matching D-Bus signal on the wire.
   *
   * One wrapper per object, holding a list of the (path, interface) pairs it
   * is currently exported under, rather than one wrapper per export. Wrapping
   * per export meant the object accumulated a wrapper for every call: the same
   * interface exported twice sent every signal twice, and nothing ever removed
   * a wrapper, so an object went on emitting signals for an interface after it
   * had been unexported. Keyed on a WeakMap so an object exported on two buses
   * gets one registration per bus, and so nothing is added to the user's
   * object.
   */
  const signalHooks = new WeakMap();

  function hookSignals(obj, path, iface) {
    if (typeof obj.emit !== 'function') return;

    let hook = signalHooks.get(obj);
    if (!hook) {
      hook = { original: obj.emit, entries: [], wrapper: null };
      hook.wrapper = function (...args) {
        const [signalName] = args;
        if (!signalName) throw new Error('Trying to emit undefined signal');

        for (const { path: signalPath, iface: signalIface } of hook.entries) {
          const signal = signalIface.signals && signalIface.signals[signalName];
          if (!signal) continue;
          const signalMsg = {
            type: constants.messageType.signal,
            serial: self.nextSerial(),
            interface: signalIface.name,
            path: signalPath,
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
        return hook.original.apply(obj, args);
      };
      obj.emit = hook.wrapper;
      signalHooks.set(obj, hook);
    }

    // Re-exporting the same interface at the same path replaces its entry.
    // Appending a second one would send every signal twice.
    const existing = hook.entries.findIndex(
      e => e.path === path && e.iface.name === iface.name
    );
    if (existing === -1) hook.entries.push({ path, iface });
    else hook.entries[existing] = { path, iface };
  }

  function unhookSignals(obj, path, interfaceNames) {
    const hook = signalHooks.get(obj);
    if (!hook) return;

    hook.entries = hook.entries.filter(
      e => !(e.path === path && interfaceNames.includes(e.iface.name))
    );
    if (hook.entries.length > 0) return;

    // Nothing left to announce, so get out of the object's way -- unless
    // somebody wrapped `emit` on top of ours, in which case removing it would
    // take theirs with it. An empty entry list makes the wrapper a no-op
    // anyway.
    if (obj.emit === hook.wrapper) obj.emit = hook.original;
    signalHooks.delete(obj);
  }

  this.exportInterface = function (obj, path, iface) {
    // Checked here rather than at the first method call: an object exported
    // under a name a peer cannot route to is unreachable, and the useful place
    // to say so is where the mistake was made.
    assertValidName('object path', path);
    assertValidName('interface name', iface.name, 'the interface descriptor');
    for (const kind of ['methods', 'signals']) {
      for (const member of Object.keys(iface[kind] || {})) {
        assertValidName('member name', member, `${kind}.${member}`);
      }
    }
    // Properties get their own, looser rule. A method or signal name is a
    // header field the daemon parses, so an invalid one is unreachable; a
    // property name is only ever a string argument to Properties.Get/Set, and
    // '-' in one works everywhere. See isValidPropertyName.
    for (const name of Object.keys(iface.properties || {})) {
      assertValidName('property name', name, `properties.${name}`);
    }

    let entry;
    if (!self.exportedObjects[path]) {
      entry = self.exportedObjects[path] = Object.create(null);
    } else {
      entry = self.exportedObjects[path];
    }
    entry[iface.name] = [iface, obj];
    hookSignals(obj, path, iface);

    // Tell anyone watching a manager above this path. Only the new interface
    // is announced, not everything at the path: re-exporting one interface on
    // an object that already had three is not news about the other three.
    self.emitInterfacesAdded(path, [iface.name]);
  };

  /**
   * Export an interface definition, and get something that unexports it.
   *
   *     const greeter = defineInterface({ ... });
   *     await using reg = await bus.export('/com/example/Greeter', greeter);
   *
   * Takes what `defineInterface()` returns. `exportInterface()` is still there
   * and still takes the positional descriptor; this is the same machinery with
   * the lifetime attached.
   */
  this.export = async function (path, definition) {
    if (!definition || !definition.descriptor || !definition.impl) {
      throw new TypeError(
        'bus.export expects an interface from defineInterface()'
      );
    }
    self.exportInterface(definition.impl, path, definition.descriptor);
    let removed = false;
    const registration = {
      path,
      interfaceName: definition.name,
      get removed() {
        return removed;
      },
      async remove() {
        if (removed) return;
        removed = true;
        self.unexportInterface(path, definition.name);
      },
      async [Symbol.asyncDispose]() {
        await registration.remove();
      }
    };
    return registration;
  };

  /**
   * Stop serving an object, or one interface of it.
   *
   * Needed for InterfacesRemoved to mean anything -- a manager that can only
   * ever report objects appearing is half an implementation, and a service
   * whose devices come and go is the normal case rather than the exotic one.
   *
   * @param {string} path the object path
   * @param {string} [interfaceName] only this interface; otherwise the object
   * @returns {boolean} whether anything was actually removed
   */
  this.unexportInterface = function (path, interfaceName) {
    const entry = self.exportedObjects[path];
    if (!entry) return false;

    let removed;
    // The objects behind the interfaces going away, before the entries are
    // gone: each needs its signal registration removed, or it carries on
    // putting signals on the wire for a path it no longer serves.
    let unhooked;
    if (interfaceName === undefined) {
      removed = Object.keys(entry);
      unhooked = removed.map(name => entry[name][1]);
      delete self.exportedObjects[path];
    } else {
      if (!Object.hasOwn(entry, interfaceName)) return false;
      removed = [interfaceName];
      unhooked = [entry[interfaceName][1]];
      delete entry[interfaceName];
      // An object with no interfaces left is not an object. Leaving the empty
      // entry would keep it in Introspect and in GetManagedObjects as a path
      // with nothing on it.
      if (Object.keys(entry).length === 0) delete self.exportedObjects[path];
    }

    for (const obj of new Set(unhooked)) unhookSignals(obj, path, removed);

    self.emitInterfacesRemoved(path, removed);
    return true;
  };

  /**
   * Serve org.freedesktop.DBus.ObjectManager at `path`.
   *
   * It reports every object exported **strictly below** `path`, which is why
   * BlueZ puts one at '/' and reports '/org/bluez/hci0'. Managers may nest;
   * the deepest one containing an object is the one that announces it.
   *
   * Opt-in rather than automatic: the interface has to appear in the
   * introspection XML for a client to know to use it, and a service that has
   * not thought about its object tree should not claim to manage one.
   */
  this.exportObjectManager = function (path) {
    assertValidName('object path', path);
    self.objectManagers.add(path);
    return self;
  };

  /**
   * The remote object, as an object.
   *
   *     const notifications = await bus.proxy(
   *       'org.freedesktop.Notifications',
   *       '/org/freedesktop/Notifications'
   *     );
   *     await notifications.Notify('app', 0, '', 'hi', '', [], {}, 5000);
   *     await notifications.$props.$all();
   *
   * Introspects once and resolves each member against what the object actually
   * declares, instead of making the caller name the interface first. A member
   * declared by two interfaces throws rather than being guessed at; name one
   * with `{ interface }` or reach for `$as()`.
   *
   * Everything the proxy adds is `$`-prefixed, which cannot collide: a D-Bus
   * member name is `[A-Za-z_][A-Za-z0-9_]*`, so `$` is not merely an unlikely
   * prefix but an impossible one.
   *
   * @param {string} service the bus name
   * @param {string} path the object path
   * @param {{interface?: string}} [options] restrict lookups to one interface
   */
  this.proxy = async function (service, path, options) {
    const { createProxy } = require('./proxy');
    const obj = await self.getObject(service, path);
    return createProxy(obj, options || {});
  };

  /**
   * A live view of the objects a service manages below `path`.
   *
   * One round trip for the whole tree, then kept current from
   * InterfacesAdded, InterfacesRemoved and PropertiesChanged. Values are plain
   * whatever shape this connection reads in.
   *
   *     const bluez = await bus.objects('org.bluez', '/');
   *     const devices = bluez.filter('org.bluez.Device1');
   *     bluez.on('added', (path, interfaces) => { ... });
   *     await bluez.close();
   *
   * @param {string} service the bus name to watch
   * @param {string} path the manager's object path
   * @param {{properties?: boolean}} [options] `properties: false` to skip
   *   tracking PropertiesChanged, and the match rule that costs
   * @returns {Promise<import('./managed-objects').ManagedObjects>}
   */
  this.objects = function (service, path, options) {
    const { ManagedObjects } = require('./managed-objects');
    return new ManagedObjects(self, service, path, options || {}).start();
  };

  /** InterfacesAdded, if any manager is responsible for this path. */
  this.emitInterfacesAdded = function (path, interfaceNames) {
    const manager = objectManager.managerFor(self.objectManagers, path);
    if (manager === undefined) return;
    const interfaces = objectManager.interfacesAndProperties(
      self.exportedObjects[path],
      interfaceNames
    );
    self.connection.message(
      objectManager.addedSignal(self.nextSerial(), manager, path, interfaces)
    );
  };

  /** InterfacesRemoved, if any manager is responsible for this path. */
  this.emitInterfacesRemoved = function (path, interfaceNames) {
    const manager = objectManager.managerFor(self.objectManagers, path);
    if (manager === undefined || interfaceNames.length === 0) return;
    self.connection.message(
      objectManager.removedSignal(
        self.nextSerial(),
        manager,
        path,
        interfaceNames
      )
    );
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

  /**
   * Put back what a reconnect took away.
   *
   * A new socket is a new client as far as the bus is concerned: the unique
   * name is different, no well-known name is owned, and no match rule exists.
   * Objects exported with `exportInterface` live here rather than there and so
   * need nothing -- but nobody can reach them until the names are back, which
   * is why this finishes before 'reconnected' is emitted.
   *
   * It deliberately does **not** retry calls that were in flight. Those were
   * already failed with ConnectionClosedError when the socket went, and a
   * method call is not idempotent -- replaying one could charge a card twice.
   * Re-issuing is the caller's decision, which is what the event is for.
   */
  conn.on('reconnect', () => {
    const wanted = [...self.names];
    const rules = [...self.matchRules];
    self.names.clear();
    // Rebuilt as the calls succeed, so a rule that fails to reinstate is not
    // left looking as though it is in place.
    self.matchRules.clear();

    const finish = err =>
      err
        ? self.emit('reconnectError', err)
        : self.emit('reconnected', { name: self.name, names: [...self.names] });

    self.invokeDbus({ member: 'Hello' }, (helloErr, name) => {
      if (helloErr) return finish(helloErr);
      self.name = name;
      const steps = [
        ...wanted.map(n => () => self.requestName(n, 0)),
        ...rules.map(rule => () => self.addMatch(rule))
      ];
      // Sequential rather than parallel: the order names were taken in can
      // matter to a service that owns several, and a bus that has just come
      // back is not the moment to open a dozen calls at once.
      steps
        .reduce((chain, step) => chain.then(step), Promise.resolve())
        .then(() => finish(), finish);
    });
  });

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
          Object.keys(this.proxy),
          this.nodes
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
    // Recorded before the reply rather than after: the daemon starts routing
    // when it processes the rule, so a reconnect in between should still put
    // this one back.
    self.matchRules.add(match);
    return this.invokeDbus(
      { member: 'AddMatch', signature: 's', body: [match] },
      callback
    );
  };

  this.removeMatch = function (match, callback) {
    self.matchRules.delete(match);
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
}

Object.setPrototypeOf(bus.prototype, EventEmitter.prototype);

module.exports = bus;
