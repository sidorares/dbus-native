// An in-process message bus.
//
// `createServer` has always handed you one `DBusConnection` per accepted socket
// with nothing between them: two clients could connect and neither could
// address the other, because nothing assigned names or routed anything. This is
// the missing part -- name ownership, org.freedesktop.DBus, and routing.
//
// What it is for: a bus the test suite can start in-process, so running the
// integration tests does not require dbus-daemon to be installed. It is not a
// replacement for dbus-daemon. There is no security policy, no service
// activation, no fd passing, and no eavesdropping; see the notes at the bottom.
//
// https://dbus.freedesktop.org/doc/dbus-specification.html#message-bus

const { EventEmitter } = require('events');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Required lazily-ish, as lib/server.js does: index.js requires this module
// while it is still assembling its own exports, so createConnection is only
// reachable by the time a socket is accepted.
const dbus = require('../index');
const constants = require('./constants');
const { parse: parseRule, matches } = require('./match-rule');
const { isValidBusName } = require('./names');
const { generateGuid } = require('./server-handshake');

const BUS_NAME = 'org.freedesktop.DBus';
const BUS_PATH = '/org/freedesktop/DBus';
const BUS_INTERFACE = 'org.freedesktop.DBus';

/** RequestName flags. */
const NAME_FLAG = {
  ALLOW_REPLACEMENT: 1,
  REPLACE_EXISTING: 2,
  DO_NOT_QUEUE: 4
};

/** RequestName results. */
const REQUEST_NAME = {
  PRIMARY_OWNER: 1,
  IN_QUEUE: 2,
  EXISTS: 3,
  ALREADY_OWNER: 4
};

/** ReleaseName results. */
const RELEASE_NAME = {
  RELEASED: 1,
  NON_EXISTENT: 2,
  NOT_OWNER: 3
};

const ERR = name => `org.freedesktop.DBus.Error.${name}`;

// The bus's own introspection data, so `busctl introspect org.freedesktop.DBus
// /org/freedesktop/DBus` and gdbus both work against it.
const BUS_INTROSPECTION = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
    "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="org.freedesktop.DBus">
    <method name="Hello">
      <arg direction="out" type="s"/>
    </method>
    <method name="RequestName">
      <arg direction="in" type="s"/>
      <arg direction="in" type="u"/>
      <arg direction="out" type="u"/>
    </method>
    <method name="ReleaseName">
      <arg direction="in" type="s"/>
      <arg direction="out" type="u"/>
    </method>
    <method name="ListNames">
      <arg direction="out" type="as"/>
    </method>
    <method name="ListActivatableNames">
      <arg direction="out" type="as"/>
    </method>
    <method name="NameHasOwner">
      <arg direction="in" type="s"/>
      <arg direction="out" type="b"/>
    </method>
    <method name="GetNameOwner">
      <arg direction="in" type="s"/>
      <arg direction="out" type="s"/>
    </method>
    <method name="ListQueuedOwners">
      <arg direction="in" type="s"/>
      <arg direction="out" type="as"/>
    </method>
    <method name="AddMatch">
      <arg direction="in" type="s"/>
    </method>
    <method name="RemoveMatch">
      <arg direction="in" type="s"/>
    </method>
    <method name="GetId">
      <arg direction="out" type="s"/>
    </method>
    <method name="GetConnectionCredentials">
      <arg direction="in" type="s"/>
      <arg direction="out" type="a{sv}"/>
    </method>
    <method name="GetConnectionUnixUser">
      <arg direction="in" type="s"/>
      <arg direction="out" type="u"/>
    </method>
    <method name="GetConnectionUnixProcessID">
      <arg direction="in" type="s"/>
      <arg direction="out" type="u"/>
    </method>
    <method name="StartServiceByName">
      <arg direction="in" type="s"/>
      <arg direction="in" type="u"/>
      <arg direction="out" type="u"/>
    </method>
    <method name="UpdateActivationEnvironment">
      <arg direction="in" type="a{ss}"/>
    </method>
    <signal name="NameOwnerChanged">
      <arg type="s"/>
      <arg type="s"/>
      <arg type="s"/>
    </signal>
    <signal name="NameAcquired">
      <arg type="s"/>
    </signal>
    <signal name="NameLost">
      <arg type="s"/>
    </signal>
    <property name="Features" type="as" access="read"/>
    <property name="Interfaces" type="as" access="read"/>
  </interface>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect">
      <arg direction="out" type="s"/>
    </method>
  </interface>
  <interface name="org.freedesktop.DBus.Peer">
    <method name="Ping"/>
    <method name="GetMachineId">
      <arg direction="out" type="s"/>
    </method>
  </interface>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get">
      <arg direction="in" type="s"/>
      <arg direction="in" type="s"/>
      <arg direction="out" type="v"/>
    </method>
    <method name="GetAll">
      <arg direction="in" type="s"/>
      <arg direction="out" type="a{sv}"/>
    </method>
  </interface>
</node>`;

/**
 * A machine id, for Peer.GetMachineId.
 *
 * The real file is what other implementations compare against, so it is
 * preferred; a made-up one is only so the method has something to answer with
 * on a machine that has none.
 */
function machineId() {
  for (const file of ['/var/lib/dbus/machine-id', '/etc/machine-id']) {
    try {
      const id = fs.readFileSync(file, 'ascii').trim();
      if (/^[0-9a-f]{32}$/.test(id)) return id;
    } catch {
      /* try the next one */
    }
  }
  return crypto.createHash('md5').update(os.hostname()).digest('hex');
}

/**
 * Start a message bus.
 *
 * `opts`:
 *   guid, authMethods, anonymous, authorize, cookieContext, authTimeout
 *     -- passed to the server handshake, see lib/server-handshake.js
 *
 * Emits 'connection' (a client joined, before Hello), 'disconnect', and
 * 'error'.
 */
function createBroker(opts = {}) {
  const broker = new EventEmitter();
  const guid = opts.guid || generateGuid();
  const id = generateGuid();
  const machine = machineId();

  /** Every connected client, whether or not it has said Hello. */
  const clients = new Set();
  /** ':1.N' -> client */
  const unique = new Map();
  /** well-known name -> [{client, allowReplacement}], index 0 is the owner */
  const names = new Map();
  let nextUnique = 1;
  let server = null;
  let listenAddress = null;

  // ---------------------------------------------------------------- sending

  function send(client, msg) {
    if (!client || client.gone) return false;
    try {
      client.conn.message({
        serial: client.serial++,
        sender: BUS_NAME,
        ...msg
      });
      return true;
    } catch (err) {
      // A client that went away mid-write is not worth reporting. Anything
      // else is a bug in here, and it is thrown rather than swallowed: a
      // reply the bus failed to marshal leaves the caller waiting forever,
      // which is the worst way for a bug here to present itself.
      if (client.gone) return false;
      throw err;
    }
  }

  const reply = (client, call, signature, body) =>
    send(client, {
      type: constants.messageType.methodReturn,
      replySerial: call.serial,
      destination: call.sender,
      ...(signature ? { signature, body } : {})
    });

  const replyError = (client, call, name, text) =>
    send(client, {
      type: constants.messageType.error,
      replySerial: call.serial,
      destination: call.sender,
      errorName: name,
      signature: 's',
      body: [text]
    });

  /** Deliver a signal to every client whose rules ask for it. */
  function broadcast(signal) {
    const msg = {
      type: constants.messageType.signal,
      sender: BUS_NAME,
      ...signal
    };
    for (const client of clients) {
      if (!client.name) continue;
      // A client sees its own broadcast if it asked for it -- checked against
      // dbus-daemon, which delivers to the sender too.
      if (client.rules.some(rule => matches(rule.parsed, msg))) {
        send(client, msg);
      }
    }
  }

  const nameOwnerChanged = (name, from, to) =>
    broadcast({
      path: BUS_PATH,
      interface: BUS_INTERFACE,
      member: 'NameOwnerChanged',
      signature: 'sss',
      body: [name, from, to]
    });

  // NameAcquired and NameLost go to the connection concerned whether or not it
  // has a matching rule; libdbus's own RequestName depends on that.
  const nameSignal = (client, member, name) =>
    send(client, {
      type: constants.messageType.signal,
      path: BUS_PATH,
      interface: BUS_INTERFACE,
      member,
      destination: client.name,
      signature: 's',
      body: [name]
    });

  // ------------------------------------------------------------------ names

  const ownerOf = name => {
    const queue = names.get(name);
    return queue && queue.length ? queue[0].client : undefined;
  };

  /** Resolve a destination to a client: a unique name, or a well-known one. */
  const resolve = destination =>
    destination.startsWith(':')
      ? unique.get(destination)
      : ownerOf(destination);

  function requestName(client, name, flags) {
    const queue = names.get(name);
    if (!queue) {
      names.set(name, [
        { client, allowReplacement: !!(flags & NAME_FLAG.ALLOW_REPLACEMENT) }
      ]);
      client.owned.add(name);
      nameOwnerChanged(name, '', client.name);
      nameSignal(client, 'NameAcquired', name);
      return REQUEST_NAME.PRIMARY_OWNER;
    }

    const existing = queue.findIndex(entry => entry.client === client);
    if (existing === 0) {
      queue[0].allowReplacement = !!(flags & NAME_FLAG.ALLOW_REPLACEMENT);
      return REQUEST_NAME.ALREADY_OWNER;
    }
    if (existing > 0) {
      queue[existing].allowReplacement = !!(
        flags & NAME_FLAG.ALLOW_REPLACEMENT
      );
      return REQUEST_NAME.IN_QUEUE;
    }

    if (flags & NAME_FLAG.REPLACE_EXISTING && queue[0].allowReplacement) {
      const previous = queue[0].client;
      previous.owned.delete(name);
      queue.shift();
      queue.unshift({
        client,
        allowReplacement: !!(flags & NAME_FLAG.ALLOW_REPLACEMENT)
      });
      // The one that lost it goes back in the queue, so releasing the new
      // owner's claim hands it back rather than dropping the name entirely.
      queue.splice(1, 0, { client: previous, allowReplacement: true });
      client.owned.add(name);
      nameSignal(previous, 'NameLost', name);
      nameSignal(client, 'NameAcquired', name);
      nameOwnerChanged(name, previous.name, client.name);
      return REQUEST_NAME.PRIMARY_OWNER;
    }

    if (flags & NAME_FLAG.DO_NOT_QUEUE) return REQUEST_NAME.EXISTS;
    queue.push({
      client,
      allowReplacement: !!(flags & NAME_FLAG.ALLOW_REPLACEMENT)
    });
    return REQUEST_NAME.IN_QUEUE;
  }

  function releaseName(client, name) {
    const queue = names.get(name);
    if (!queue) return RELEASE_NAME.NON_EXISTENT;
    const at = queue.findIndex(entry => entry.client === client);
    if (at === -1) return RELEASE_NAME.NOT_OWNER;

    queue.splice(at, 1);
    client.owned.delete(name);
    if (at !== 0) return RELEASE_NAME.RELEASED;

    nameSignal(client, 'NameLost', name);
    if (queue.length === 0) {
      names.delete(name);
      nameOwnerChanged(name, client.name, '');
    } else {
      const heir = queue[0].client;
      heir.owned.add(name);
      nameSignal(heir, 'NameAcquired', name);
      nameOwnerChanged(name, client.name, heir.name);
    }
    return RELEASE_NAME.RELEASED;
  }

  // --------------------------------------------------- the bus's own object

  function busMethod(client, msg) {
    const member = msg.member;
    const arg = (msg.body || [])[0];

    if (msg['interface'] === 'org.freedesktop.DBus.Peer') {
      if (member === 'Ping') return reply(client, msg);
      if (member === 'GetMachineId') return reply(client, msg, 's', [machine]);
    }
    if (msg['interface'] === 'org.freedesktop.DBus.Introspectable') {
      if (member === 'Introspect') {
        return reply(client, msg, 's', [BUS_INTROSPECTION]);
      }
    }
    if (msg['interface'] === 'org.freedesktop.DBus.Properties') {
      // A variant is written as [signature, value]. `Features` names optional
      // behaviour this bus does not have (no header filtering, no systemd
      // activation) and `Interfaces` the extra interfaces on the bus object,
      // of which there are none, so both are empty rather than absent.
      const properties = {
        Features: ['as', []],
        Interfaces: ['as', []]
      };
      if (member === 'Get') {
        const value = properties[(msg.body || [])[1]];
        if (!value) {
          return replyError(
            client,
            msg,
            ERR('UnknownProperty'),
            `No such property "${(msg.body || [])[1]}"`
          );
        }
        return reply(client, msg, 'v', [value]);
      }
      if (member === 'GetAll') {
        return reply(client, msg, 'a{sv}', [
          Object.entries(properties).map(([key, value]) => [key, value])
        ]);
      }
    }

    if (msg['interface'] !== BUS_INTERFACE) {
      return replyError(
        client,
        msg,
        ERR('UnknownInterface'),
        `${BUS_NAME} does not implement ${msg['interface']}`
      );
    }

    switch (member) {
      case 'Hello':
        // "Before an application is able to send messages ... it must send the
        // org.freedesktop.DBus.Hello message", and it may only do so once.
        if (client.name) {
          return replyError(
            client,
            msg,
            ERR('Failed'),
            'Already handled an Hello message'
          );
        }
        return hello(client, msg);

      case 'RequestName': {
        if (typeof arg !== 'string' || !isValidBusName(arg)) {
          return replyError(
            client,
            msg,
            ERR('InvalidArgs'),
            `"${arg}" is not a valid bus name`
          );
        }
        if (arg.startsWith(':') || arg === BUS_NAME) {
          return replyError(
            client,
            msg,
            ERR('InvalidArgs'),
            `Cannot request the name "${arg}"`
          );
        }
        const flags = (msg.body || [])[1] || 0;
        return reply(client, msg, 'u', [requestName(client, arg, flags)]);
      }

      case 'ReleaseName': {
        if (typeof arg !== 'string' || !isValidBusName(arg)) {
          return replyError(
            client,
            msg,
            ERR('InvalidArgs'),
            `"${arg}" is not a valid bus name`
          );
        }
        return reply(client, msg, 'u', [releaseName(client, arg)]);
      }

      case 'ListNames':
        return reply(client, msg, 'as', [
          [BUS_NAME, ...unique.keys(), ...names.keys()]
        ]);

      case 'ListActivatableNames':
        // Nothing here is activatable, but the bus itself always is.
        return reply(client, msg, 'as', [[BUS_NAME]]);

      case 'NameHasOwner':
        return reply(client, msg, 'b', [
          arg === BUS_NAME || resolve(String(arg)) !== undefined
        ]);

      case 'GetNameOwner': {
        if (arg === BUS_NAME) return reply(client, msg, 's', [BUS_NAME]);
        const owner = resolve(String(arg));
        if (!owner) {
          return replyError(
            client,
            msg,
            ERR('NameHasNoOwner'),
            `Could not get owner of name "${arg}": no such name`
          );
        }
        return reply(client, msg, 's', [owner.name]);
      }

      case 'ListQueuedOwners': {
        const queue = names.get(String(arg));
        if (!queue) {
          return replyError(
            client,
            msg,
            ERR('NameHasNoOwner'),
            `Could not get owners of name "${arg}": no such name`
          );
        }
        return reply(client, msg, 'as', [
          queue.map(entry => entry.client.name)
        ]);
      }

      case 'AddMatch': {
        let parsed;
        try {
          parsed = parseRule(String(arg));
        } catch (err) {
          return replyError(client, msg, ERR('MatchRuleInvalid'), err.message);
        }
        client.rules.push({ text: String(arg), parsed });
        return reply(client, msg);
      }

      case 'RemoveMatch': {
        const at = client.rules.findIndex(rule => rule.text === String(arg));
        if (at === -1) {
          return replyError(
            client,
            msg,
            ERR('MatchRuleNotFound'),
            'The given match rule was not found'
          );
        }
        client.rules.splice(at, 1);
        return reply(client, msg);
      }

      case 'GetId':
        return reply(client, msg, 's', [id]);

      case 'GetConnectionCredentials':
      case 'GetConnectionUnixUser':
      case 'GetConnectionUnixProcessID': {
        // Node cannot read a peer's credentials from a socket, so the only
        // honest answers are the uid the handshake was told and our own pid --
        // right for an in-process bus, and meaningless for anything else.
        //
        // The bus answers for its own name too, as dbus-daemon does: it is a
        // connection like any other from a caller's point of view.
        const own =
          typeof process.getuid === 'function' ? process.getuid() : null;
        let uid;
        if (arg === BUS_NAME) {
          uid = own;
        } else {
          const target = resolve(String(arg));
          if (!target) {
            return replyError(
              client,
              msg,
              ERR('NameHasNoOwner'),
              `Could not get owner of name "${arg}": no such name`
            );
          }
          uid = target.identity ? target.identity.uid : null;
        }

        if (member === 'GetConnectionCredentials') {
          // The modern replacement for the other two, and what most code asks
          // for now. Fields it cannot answer are left out rather than guessed:
          // the dict is defined as open-ended.
          const credentials = [['ProcessID', ['u', process.pid]]];
          if (uid !== null && uid !== undefined) {
            credentials.push(['UnixUserID', ['u', uid]]);
          }
          return reply(client, msg, 'a{sv}', [credentials]);
        }

        const value = member === 'GetConnectionUnixUser' ? uid : process.pid;
        if (value === null || value === undefined) {
          return replyError(
            client,
            msg,
            ERR('Failed'),
            'Could not determine the credentials of that connection'
          );
        }
        return reply(client, msg, 'u', [value]);
      }

      case 'StartServiceByName':
        return replyError(
          client,
          msg,
          ERR('ServiceUnknown'),
          `The name ${arg} was not provided by any .service files -- this bus does not activate services`
        );

      case 'UpdateActivationEnvironment':
        return reply(client, msg);

      default:
        return replyError(
          client,
          msg,
          ERR('UnknownMethod'),
          `${BUS_NAME} has no method ${member}`
        );
    }
  }

  function hello(client, msg) {
    client.name = `:1.${nextUnique++}`;
    unique.set(client.name, client);
    reply(client, msg, 's', [client.name]);
    // The order matters: the reply carries the name, and only then can the
    // client make sense of a signal addressed to it.
    nameOwnerChanged(client.name, '', client.name);
    nameSignal(client, 'NameAcquired', client.name);
    broker.emit('hello', client.name);
  }

  // -------------------------------------------------------------- routing

  function route(client, msg) {
    // Until Hello there is no name to put in `sender`, so nothing else can be
    // delivered or replied to.
    if (!client.name) {
      const isHello =
        msg.destination === BUS_NAME &&
        msg['interface'] === BUS_INTERFACE &&
        msg.member === 'Hello';
      if (!isHello) {
        replyError(
          client,
          msg,
          ERR('AccessDenied'),
          'Client tried to send a message other than Hello without being registered'
        );
        return;
      }
    }

    // The daemon stamps the sender itself; a client cannot claim to be someone
    // else, and anything it put there is overwritten.
    msg.sender = client.name;

    if (msg.destination === BUS_NAME) {
      if (msg.type !== constants.messageType.methodCall) return;
      if (msg.path !== undefined && msg.path !== BUS_PATH) {
        return replyError(
          client,
          msg,
          ERR('UnknownObject'),
          `${BUS_NAME} has no object at ${msg.path}`
        );
      }
      return busMethod(client, msg);
    }

    if (msg.destination) {
      const target = resolve(msg.destination);
      if (!target) {
        // A signal to a name nobody owns is dropped; a call gets told.
        if (msg.type === constants.messageType.methodCall) {
          replyError(
            client,
            msg,
            ERR('NameHasNoOwner'),
            `The name ${msg.destination} was not provided by any .service files`
          );
        }
        return;
      }
      send(target, msg);
      // A unicast message still reaches anyone whose rule asks for it -- that
      // is how dbus-monitor sees traffic addressed elsewhere. Not implemented:
      // eavesdropping needs BecomeMonitor, and delivering unicast traffic to
      // third parties without it would be a surprise.
      return;
    }

    if (msg.type === constants.messageType.signal) return broadcast(msg);

    replyError(
      client,
      msg,
      ERR('Failed'),
      'A method call must name a destination'
    );
  }

  // ---------------------------------------------------------- connections

  function accept(stream) {
    const conn = dbus.createConnection({
      stream,
      server: true,
      guid,
      authMethods: opts.authMethods,
      anonymous: opts.anonymous,
      authorize: opts.authorize,
      cookieContext: opts.cookieContext,
      authTimeout: opts.authTimeout,
      // Forwarding here means unmarshalling a message and marshalling it
      // again, so every value has to survive the round trip -- and by default
      // a 64-bit integer does not. It is read as a Number, which is lossy
      // above 2^53, and then refused on the way out with "Number outside
      // range". A bus that quietly rounds someone's payload would be worse.
      //
      // The proper fix is not to re-encode at all: a router should keep the
      // body bytes and rewrite only the header fields it must. That needs the
      // message layer to hand back the raw frame, which it does not do today
      // -- see ROADMAP 4.5. Until then, reading 64-bit values exactly is what
      // makes the round trip faithful.
      returnBigInt: true
    });

    const client = {
      conn,
      stream,
      name: null,
      serial: 1,
      owned: new Set(),
      rules: [],
      identity: null,
      gone: false
    };
    clients.add(client);

    conn.on('connect', () => {
      client.identity = conn.identity || null;
      broker.emit('connection', client);
    });
    conn.on('message', msg => {
      try {
        route(client, msg);
      } catch (err) {
        // One client's bad message must not take the bus down with it -- and a
        // caller waiting on a reply is owed one, even when the reason it did
        // not arrive is a fault in here.
        broker.emit('clientError', err, client);
        if (msg.type === constants.messageType.methodCall && client.name) {
          try {
            replyError(client, msg, ERR('Failed'), err.message);
          } catch {
            /* nothing left to say it with */
          }
        }
      }
    });
    conn.on('error', err => broker.emit('clientError', err, client));
    const drop = () => {
      if (client.gone) return;
      client.gone = true;
      clients.delete(client);
      for (const name of [...client.owned]) releaseName(client, name);
      if (client.name) {
        unique.delete(client.name);
        nameOwnerChanged(client.name, client.name, '');
      }
      broker.emit('disconnect', client);
    };
    conn.on('end', drop);
    conn.on('close', drop);
  }

  // --------------------------------------------------------------- public

  /**
   * Start listening.
   *
   * `{socket}` for a unix socket, `{port, host}` for TCP, or nothing for a
   * unix socket in a temporary directory. Calls back with the address.
   */
  broker.listen = function listen(where, cb) {
    if (typeof where === 'function') {
      cb = where;
      where = undefined;
    }
    const target = where || {
      socket: path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-broker-')),
        'socket'
      )
    };

    server = net.createServer(accept);
    server.on('error', err => broker.emit('error', err));

    const done = () => {
      if (target.socket) {
        listenAddress = `unix:path=${target.socket},guid=${guid}`;
      } else {
        const { port, address } = server.address();
        listenAddress = `tcp:host=${address},port=${port},guid=${guid}`;
      }
      broker.emit('listening', listenAddress);
      if (cb) cb(null, listenAddress);
    };

    if (target.socket) server.listen(target.socket, done);
    else server.listen(target.port || 0, target.host || '127.0.0.1', done);
    return broker;
  };

  /** The address a client should connect to, once listening. */
  broker.address = () => listenAddress;
  broker.guid = guid;
  broker.id = id;

  /** Names currently on the bus, as ListNames would report them. */
  broker.names = () => [BUS_NAME, ...unique.keys(), ...names.keys()];

  broker.close = function close(cb) {
    for (const client of [...clients]) {
      try {
        client.stream.destroy();
      } catch {
        /* already gone */
      }
    }
    clients.clear();
    if (!server) {
      if (cb) cb();
      return broker;
    }
    const socket = listenAddress && /^unix:path=([^,]+)/.exec(listenAddress);
    server.close(() => {
      // A unix socket outlives the server that bound it.
      if (socket) {
        try {
          fs.rmSync(socket[1], { force: true });
          fs.rmdirSync(path.dirname(socket[1]));
        } catch {
          /* someone else's to clean up */
        }
      }
      if (cb) cb();
    });
    return broker;
  };

  return broker;
}

module.exports = {
  createBroker,
  NAME_FLAG,
  REQUEST_NAME,
  RELEASE_NAME,
  BUS_NAME,
  BUS_PATH
};
