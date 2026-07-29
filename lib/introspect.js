const xml2js = require('xml2js');
const { maybePromise } = require('./promisify');
const { variantValue } = require('./values');
const { ConnectionClosedError } = require('./errors');

module.exports.introspectBus = function (obj, callback) {
  const bus = obj.service.bus;
  bus.invoke(
    {
      destination: obj.service.name,
      path: obj.name,
      interface: 'org.freedesktop.DBus.Introspectable',
      member: 'Introspect'
    },
    (err, xml) => {
      module.exports.processXML(err, xml, obj, callback);
    }
  );
};

module.exports.processXML = function (err, xml, obj, callback) {
  if (err) return callback(err);
  const parser = new xml2js.Parser();
  parser.parseString(xml, (err, result) => {
    if (err) return callback(err);
    // A peer that answers Introspect with something other than a <node>
    // document is misbehaving, but throwing here would go straight past the
    // callback and out of the socket read handler as an uncaught exception.
    //
    // Tested for the key rather than a truthy value: xml2js renders an empty
    // `<node/>` as `{ node: '' }`, and that is a well-formed answer meaning
    // "nothing here" -- this library's own server sends exactly that for a
    // path it has not exported. Checking truthiness reported it as a document
    // with no root node, which is both wrong and unhelpful.
    if (!Object.hasOwn(result, 'node')) {
      return callback(new Error('No root XML node'));
    }
    result = result.node || {}; // unwrap the root node

    // The child object paths.
    //
    // This loop used to start at 1, on the reasoning that the root node had to
    // be skipped -- but `result` is *already* the unwrapped root, so
    // `result.node` is the list of children and element 0 is one of them.
    // `obj.nodes` therefore always dropped whichever child came first.
    const xmlnodes = result['node'] || [];
    const nodes = xmlnodes
      .map(node => node['$'] && node['$'].name)
      .filter(name => name !== undefined);

    const ifaces = result['interface'];

    // A path with no interfaces on it is a perfectly ordinary thing: it is how
    // a service groups its objects, and /org/freedesktop/UPower/devices is
    // nothing but a container.
    //
    // This used to re-introspect the *first* child and hand that back as
    // though it were the object asked for -- so getObject('/com/example')
    // silently returned a proxy for '/com/example/Alpha', calls went to the
    // wrong object, every other child was discarded, and `obj.name` was
    // rewritten in place (`Object.assign(obj, {})` assigns nothing onto obj
    // and returns obj, so it mutated the caller's object rather than copying
    // it). The child list was lost too, which is the one thing a caller
    // introspecting a container actually wants.
    //
    // So: report the object that was asked for. No interfaces, and the
    // children in `nodes`. `obj.as()` then throws UnknownInterfaceError, which
    // names the children so the mistake is obvious.
    if (!ifaces) return callback(null, {}, nodes);

    const proxy = {};
    let ifaceName, method, property, iface, arg, signature, currentIface;

    for (let i = 0; i < ifaces.length; ++i) {
      iface = ifaces[i];
      ifaceName = iface['$'].name;
      currentIface = proxy[ifaceName] = new DBusInterface(obj, ifaceName);

      for (let m = 0; iface.method && m < iface.method.length; ++m) {
        method = iface.method[m];
        signature = '';
        const methodName = method['$'].name;
        for (let a = 0; method.arg && a < method.arg.length; ++a) {
          arg = method.arg[a]['$'];
          if (arg.direction === 'in') signature += arg.type;
        }
        // add method
        currentIface.$createMethod(methodName, signature);
      }
      for (let p = 0; iface.property && p < iface.property.length; ++p) {
        property = iface.property[p];
        currentIface.$createProp(
          property['$'].name,
          property['$'].type,
          property['$'].access
        );
      }
      for (let s = 0; iface.signal && s < iface.signal.length; ++s) {
        const sig = iface.signal[s];
        signature = '';
        const argNames = [];
        for (let a = 0; sig.arg && a < sig.arg.length; ++a) {
          arg = sig.arg[a]['$'];
          signature += arg.type || '';
          // A name is optional in the XML, and plenty of services omit it.
          // Fall back to a positional one so the descriptor is always the
          // [signature, ...names] shape the service side uses.
          argNames.push(arg.name || `arg${a}`);
        }
        currentIface.$createSignal(sig['$'].name, signature, argNames);
      }
    }
    callback(null, proxy, nodes);
  });
};

function DBusInterface(parent_obj, ifname) {
  // Since methods and props presently get added directly to the object, to avoid collision with existing names we must use $ naming convention as $ is invalid for dbus member names
  // https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names
  this.$parent = parent_obj; // parent DbusObject
  this.$name = ifname; // string interface name
  this.$methods = {}; // dictionary of methods (exposed for test), should we just store signature or use object to store more info?
  this.$signals = {}; // signal name -> [signature, ...argumentNames]
  this.$properties = {};
  // signal name -> Map(listener -> { wrapper, count }), where `wrapper` is
  // what is registered on bus.signals and `count` is how many times, since
  // EventEmitter lets the same listener be added more than once.
  //
  // Keyed per signal name. This used to be two flat arrays shared by the whole
  // interface, which could not tell two signals apart: unsubscribing the last
  // listener of one signal emptied the bookkeeping for every other signal on
  // the interface, so the next off() built a wrapper it had never registered,
  // removed nothing, and left the listener firing forever.
  this.$sigHandlers = new Map();
}

/**
 * Find the key under which `callback` is registered.
 *
 * once() registers a wrapper rather than the listener itself, and records the
 * original on `.listener` -- the same arrangement Node's EventEmitter uses --
 * so that off(name, originalCallback) still cancels it.
 */
function findRegistration(handlers, callback) {
  if (handlers.has(callback)) return callback;
  for (const registered of handlers.keys()) {
    if (registered.listener === callback) return registered;
  }
  return undefined;
}

/**
 * Report a failed AddMatch/RemoveMatch from the fire-and-forget on()/off()
 * paths, which have nowhere to return it.
 *
 * These used to `throw` from inside the reply handler, which the read loop
 * turned into a connection 'handlerError' (or an asynchronous rethrow when
 * nobody was listening). Keep exactly that, so existing handlers still see it
 * -- and use $subscribe()/$unsubscribe() when you would rather handle it.
 */
function reportSubscriptionError(bus, err) {
  // A match rule on a connection that has gone away is not worth reporting,
  // let alone crashing over: there is nothing left to subscribe to. Ending a
  // connection shortly after off() is an ordinary shutdown, and RemoveMatch
  // losing the race with the close used to take the whole process down --
  // intermittently, since it depends on which arrives first.
  if (err instanceof ConnectionClosedError) return;

  const connection = bus.connection;
  if (connection && connection.listenerCount('handlerError') > 0) {
    connection.emit('handlerError', err);
    return;
  }
  process.nextTick(() => {
    throw err;
  });
}

const settled = () => maybePromise(undefined, cb => cb(null));

/** The registration for a listener, created on first use. */
function registrationFor(iface, signame, callback) {
  let handlers = iface.$sigHandlers.get(signame);
  if (!handlers) iface.$sigHandlers.set(signame, (handlers = new Map()));
  let entry = handlers.get(callback);
  if (!entry) {
    entry = {
      wrapper: function (messageBody) {
        callback.apply(null, messageBody);
      },
      count: 0
    };
    handlers.set(callback, entry);
  }
  return entry;
}

DBusInterface.prototype.$getSigHandler = function (signame, callback) {
  return registrationFor(this, signame, callback).wrapper;
};

/**
 * Subscribe, and report when the match rule is actually in place.
 *
 * on() cannot do that: it follows EventEmitter and returns `this`. Await this
 * instead when you need to know the subscription is live before triggering
 * whatever produces the signal, or when you want to handle AddMatch failing.
 */
DBusInterface.prototype.$subscribe = function (signame, callback) {
  // http://dbus.freedesktop.org/doc/api/html/group__DBusBus.html#ga4eb6401ba014da3dbe3dc4e2a8e5b3ef
  // An example is "type='signal',sender='org.freedesktop.DBus', interface='org.freedesktop.DBus',member='Foo', path='/bar/foo',destination=':452345.34'" ...
  const bus = this.$parent.service.bus;
  const signalFullName = bus.mangle(this.$parent.name, this.$name, signame);
  const first = bus.signals.listenerCount(signalFullName) === 0;
  const entry = registrationFor(this, signame, callback);
  entry.count++;

  // Registered before AddMatch is confirmed rather than in its reply: the
  // daemon starts routing when it processes the rule, which is necessarily
  // before the reply gets back to us, and a signal arriving in that window
  // used to be dropped.
  bus.signals.on(signalFullName, entry.wrapper);
  if (!first) return settled(); // somebody already has the match rule

  return maybePromise(undefined, cb =>
    bus.addMatch(getMatchRule(this.$parent.name, this.$name, signame), err => {
      // `err` is a DBusError since 0.7; wrapping it in a plain Error would
      // throw away its name, dbusName and stack.
      if (err) {
        // The subscription never took. Undo exactly what this call added --
        // not the whole entry, which may hold registrations from other calls
        // -- so this listener does not sit on a match rule that does not
        // exist, and a later on() installs the rule again.
        bus.signals.removeListener(signalFullName, entry.wrapper);
        if (--entry.count <= 0) this.$forget(signame, callback);
      }
      cb(err);
    })
  );
};

/** Unsubscribe, and report when the match rule has been dropped. */
DBusInterface.prototype.$unsubscribe = function (signame, callback) {
  const bus = this.$parent.service.bus;
  const signalFullName = bus.mangle(this.$parent.name, this.$name, signame);
  const handlers = this.$sigHandlers.get(signame);
  const registered = handlers && findRegistration(handlers, callback);
  if (!registered) return settled(); // not ours: nothing to undo

  const entry = handlers.get(registered);
  // removeListener drops one registration, so mirror that here rather than
  // discarding the entry: added twice, removed once still means subscribed.
  bus.signals.removeListener(signalFullName, entry.wrapper);
  if (--entry.count <= 0) this.$forget(signame, registered);
  // Other listeners -- possibly on another proxy for the same object -- still
  // want the signal, so the match rule has to stay.
  if (bus.signals.listenerCount(signalFullName) > 0) return settled();

  return maybePromise(undefined, cb =>
    bus.removeMatch(getMatchRule(this.$parent.name, this.$name, signame), cb)
  );
};

/** Drop one listener from the bookkeeping, and the signal when it empties. */
DBusInterface.prototype.$forget = function (signame, callback) {
  const handlers = this.$sigHandlers.get(signame);
  if (!handlers) return;
  handlers.delete(callback);
  if (handlers.size === 0) this.$sigHandlers.delete(signame);
};

DBusInterface.prototype.addListener = DBusInterface.prototype.on = function (
  signame,
  callback
) {
  const bus = this.$parent.service.bus;
  this.$subscribe(signame, callback).catch(err =>
    reportSubscriptionError(bus, err)
  );
  return this;
};

DBusInterface.prototype.once = function (signame, callback) {
  const wrapper = (...args) => {
    this.off(signame, wrapper);
    callback.apply(null, args);
  };
  wrapper.listener = callback; // so off(signame, callback) cancels it too
  return this.on(signame, wrapper);
};

DBusInterface.prototype.removeListener = DBusInterface.prototype.off =
  function (signame, callback) {
    const bus = this.$parent.service.bus;
    this.$unsubscribe(signame, callback).catch(err =>
      reportSubscriptionError(bus, err)
    );
    return this;
  };

DBusInterface.prototype.removeAllListeners = function (signame) {
  const bus = this.$parent.service.bus;
  const names =
    signame === undefined ? [...this.$sigHandlers.keys()] : [signame];
  for (const name of names) {
    const handlers = this.$sigHandlers.get(name);
    if (!handlers) continue;
    // Snapshot: $unsubscribe mutates the map as it goes. A listener added
    // more than once needs removing that many times.
    for (const [listener, entry] of [...handlers.entries()]) {
      for (let n = entry.count; n > 0; --n) {
        this.$unsubscribe(name, listener).catch(err =>
          reportSubscriptionError(bus, err)
        );
      }
    }
  }
  return this;
};

/** How many listeners this proxy has for a signal, counting duplicates. */
DBusInterface.prototype.listenerCount = function (signame) {
  const handlers = this.$sigHandlers.get(signame);
  if (!handlers) return 0;
  let total = 0;
  for (const entry of handlers.values()) total += entry.count;
  return total;
};

DBusInterface.prototype.$createSignal = function (
  sigName,
  signature,
  argNames
) {
  this.$signals[sigName] = [signature, ...argNames];
};
DBusInterface.prototype.$createMethod = function (mName, signature) {
  this.$methods[mName] = signature;
  this[mName] = function () {
    return this.$callMethod(mName, arguments);
  };
};
DBusInterface.prototype.$callMethod = function (mName, args) {
  const bus = this.$parent.service.bus;
  if (!Array.isArray(args)) args = Array.from(args); // Array.prototype.slice.apply(args)
  // A trailing function is the callback; without one the call returns a
  // promise. This is #295, extended to the rest of the surface.
  const callback =
    typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
  const msg = {
    destination: this.$parent.service.name,
    path: this.$parent.name,
    interface: this.$name,
    member: mName
  };
  if (this.$methods[mName] !== '') {
    msg.signature = this.$methods[mName];
    msg.body = args;
  }
  return bus.invoke(msg, callback);
};
DBusInterface.prototype.$createProp = function (
  propName,
  propType,
  propAccess
) {
  this.$properties[propName] = { type: propType, access: propAccess };
  Object.defineProperty(this, propName, {
    enumerable: true,
    // iface.Prop(cb) keeps working; iface.Prop() now returns a promise.
    get: () => callback => this.$readProp(propName, callback),
    set: function (val) {
      // Assignment cannot be awaited, so a failure has nowhere to go. Pass a
      // callback to keep this fire-and-forget exactly as it was; call
      // $writeProp(name, value) directly if you want to await the result.
      this.$writeProp(propName, val, () => {});
    }
  });
};
DBusInterface.prototype.$readProp = function (propName, callback) {
  const bus = this.$parent.service.bus;
  return maybePromise(callback, cb =>
    bus.invoke(
      {
        destination: this.$parent.service.name,
        path: this.$parent.name,
        interface: 'org.freedesktop.DBus.Properties',
        member: 'Get',
        signature: 'ss',
        body: [this.$name, propName]
      },
      (err, val) => {
        if (err) return cb(err);
        // Properties.Get returns a variant. variantValue() unwraps it in
        // either shape and applies the same one-value-or-all rule this used to
        // spell out by indexing into the parsed signature tree.
        cb(err, variantValue(val));
      }
    )
  );
};
DBusInterface.prototype.$writeProp = function (propName, val, callback) {
  const bus = this.$parent.service.bus;
  return bus.invoke(
    {
      destination: this.$parent.service.name,
      path: this.$parent.name,
      interface: 'org.freedesktop.DBus.Properties',
      member: 'Set',
      signature: 'ssv',
      body: [this.$name, propName, [this.$properties[propName].type, val]]
    },
    callback
  );
};

function getMatchRule(objName, ifName, signame) {
  return `type='signal',path='${objName}',interface='${ifName}',member='${signame}'`;
}
