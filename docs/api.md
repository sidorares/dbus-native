# API reference

The complete public surface of `dbus-native`, as of 0.7.

This is the reference; [the README](../README.md) is the introduction and
[RELEASE_PLAN.md](../RELEASE_PLAN.md) is where the surface is going. Anything
not listed here is internal, even if it is reachable — `bus.cookies`,
`lib/marshall`, `DBusInterface.prototype.$createMethod` and friends are
implementation, and change without a major.

**Contents**

- [Entry points](#entry-points) · [Connection options](#connection-options)
- [Callbacks and promises](#callbacks-and-promises)
- [MessageBus](#messagebus) · [Proxy API](#proxy-api)
- [Exporting a service](#exporting-a-service)
- [Connection](#connection-low-level)
- [Values and types](#values-and-types) · [Errors](#errors)
- [Diagnostics](#diagnostics) · [CLI](#cli)

---

## Entry points

```js
const dbus = require('dbus-native');
```

| function                       | returns          |                                                                       |
| ------------------------------ | ---------------- | --------------------------------------------------------------------- |
| `dbus.sessionBus(opts?)`       | `MessageBus`     | connects to `$DBUS_SESSION_BUS_ADDRESS`                               |
| `dbus.systemBus()`             | `MessageBus`     | connects to `$DBUS_SYSTEM_BUS_ADDRESS`, or the standard system socket |
| `dbus.createClient(opts?)`     | `MessageBus`     | connects to whatever `opts` describes                                 |
| `dbus.createConnection(opts?)` | `DBusConnection` | the transport alone, with no `MessageBus` on top                      |
| `dbus.createServer(handler?)`  | `DBusServer`     | accepts peer-to-peer connections — see below                          |
| `dbus.createBroker(opts?)`     | `DBusBroker`     | a message bus, not a replacement for `dbus-daemon` — see below        |

`sessionBus` and `systemBus` are `createClient` with a `busAddress` filled in;
all three take the same options.

### createServer

`handler` is called with a `DBusConnection` per accepted socket, and the
returned object has a `listen(...)` delegating to `net.Server#listen`. The
server side of the SASL handshake is real as of 0.12 — it offers `EXTERNAL` and
`DBUS_COOKIE_SHA1`, generates a GUID per server, and takes `authorize`,
`anonymous`, `authMethods` and `authTimeout` options. This is peer-to-peer:
nothing routes between two connections and no names are assigned, so a client
must connect with `direct: true` and address the peer directly.

### createBroker

A message bus, in process:

```js
const broker = dbus.createBroker();
broker.listen((err, address) => {
  const bus = dbus.createClient({ busAddress: address });
});
```

| member                       |                                                        |
| ---------------------------- | ------------------------------------------------------ |
| `broker.listen(where?, cb?)` | `{socket}`, `{port, host}`, or a temporary unix socket |
| `broker.address()`           | the address to connect to, once listening              |
| `broker.names()`             | the names on the bus, as `ListNames` would report them |
| `broker.close(cb?)`          | drop every client and stop listening                   |
| `broker.guid`, `broker.id`   | the server GUID and the bus id                         |

Events: `listening`, `connection`, `hello`, `disconnect`, `error`,
`clientError`.

It implements `org.freedesktop.DBus` — `Hello`, `RequestName`/`ReleaseName`
with the full flag and queue behaviour, `ListNames`,
`ListActivatableNames`, `NameHasOwner`, `GetNameOwner`, `ListQueuedOwners`,
`AddMatch`/`RemoveMatch`, `GetId`, `GetConnectionUnixUser`,
`GetConnectionUnixProcessID`, `StartServiceByName`,
`UpdateActivationEnvironment`, plus `Peer`, `Introspectable` and
`Properties` — and it routes: unicast by destination, signals by match rule,
`NameOwnerChanged`/`NameAcquired`/`NameLost` as names change hands.

**What it is for** is a bus the test suite can start without `dbus-daemon`
installed; `npm run test:integration:broker` runs the whole integration suite
against it. **It is not a replacement for `dbus-daemon`**: there is no security
policy, so any client may own any name and call anyone; no service activation,
so `StartServiceByName` always fails; no fd passing; and no eavesdropping, so
`dbus-monitor` cannot see traffic addressed elsewhere. Do not put it on a
socket other processes can reach.

### Connection options

| option           | type                      | default                                         |                                                                |
| ---------------- | ------------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| `busAddress`     | `string`                  | `$DBUS_SESSION_BUS_ADDRESS`                     | encoded address; `;`-separated alternatives are tried in order |
| `socket`         | `string`                  | —                                               | unix socket path                                               |
| `port`           | `number`                  | —                                               | TCP port                                                       |
| `host`           | `string`                  | `localhost`                                     | TCP host                                                       |
| `stream`         | `Duplex`                  | —                                               | use an already-connected stream                                |
| `authMethods`    | `string[]`                | `['EXTERNAL', 'DBUS_COOKIE_SHA1', 'ANONYMOUS']` | tried in order                                                 |
| `direct`         | `boolean`                 | `false`                                         | skip the opening `Hello`, for peer-to-peer connections         |
| `server`         | `boolean`                 | `false`                                         | act as the server side of the handshake                        |
| `timeout`        | `number`                  | none                                            | default timeout in ms for every call on this client            |
| `ayBuffer`       | `true \| false \| 'view'` | `true`                                          | how `ay` comes back — see [Values](#values-and-types)          |
| `maxMessageSize` | `number`                  | 128 MiB                                         | reject a message declaring more than this                      |
| `returnBigInt`   | `boolean`                 | `false`                                         | read `x`/`t` as native `bigint`, exactly — the 2.0 default     |
| `plainValues`    | `boolean`                 | `false`                                         | read variants and dicts in the 2.0 shapes — see below          |
| `variants`       | `'tree'\|'plain'\|'wrap'` | follows `plainValues`                           | how a `v` comes back; `'wrap'` keeps the signature — see below |
| `ReturnLongjs`   | `boolean`                 | `false`                                         | **deprecated** (`DBUS_DEP0001`) — 64-bit as Long.js            |

Address forms understood by `busAddress`: `unix:path=…`, `unix:abstract=…`,
`unix:socket=…`, `tcp:host=…,port=…`, `unixexec:path=…,arg1=…`, and
`launchd:env=…`.

**`launchd:env=VAR`** is how macOS advertises its session bus. The address names
an environment variable rather than a path; the socket is looked up with
`launchctl getenv VAR`, falling back to this process's own environment when
launchd has no answer for it. The lookup runs once, synchronously, during
connection setup and costs about 4 ms.

On macOS, `sessionBus()` falls back to
`launchd:env=DBUS_LAUNCHD_SESSION_BUS_SOCKET` when `DBUS_SESSION_BUS_ADDRESS`
is unset, which is the normal state there — so it works without any setup
beyond a running bus.

---

## Callbacks and promises

Every asynchronous method takes an optional Node-style `(err, result)`
callback. **Omit the callback and you get a thenable instead** — the callback
path is completely unchanged.

```js
bus.getId((err, id) => {}); // callback
const id = await bus.getId(); // promise
```

Resolution follows the number of values in the reply body, because most D-Bus
methods return zero or one:

| reply body  | resolves with      |
| ----------- | ------------------ |
| no values   | `undefined`        |
| one value   | the value          |
| two or more | an array of values |

The returned object is a **thenable, not a `Promise`**, and `instanceof
Promise` is false. This is deliberate. Calling without a callback has always
meant fire-and-forget — this repo's own examples do
`bus.invoke({ member: 'AddMatch', … })` and ignore the result — so the
underlying promise is constructed lazily, on the first `then`/`catch`/
`finally`. Ignore the return value and nothing is constructed, so a dropped
failure cannot become an unhandled rejection that terminates the process.
`await`, `Promise.all`, `.catch` and `.finally` all work normally.

The call itself always runs immediately; only _observing_ the outcome is lazy.

Rejections are always a [`DBusError`](#errors), and carry the frames from
where the call was made, stitched on after a `--- d-bus call made at ---`
marker. Without that a rejected call would only show library internals, since
the error is constructed in the socket read handler.

---

## MessageBus

### Calling methods

```js
bus.invoke(msg[, options][, callback])
bus.invokeDbus(msg[, options][, callback])
```

`invoke` sends a method call and delivers the reply. `invokeDbus` is the same
with `path`, `destination` and `interface` defaulted to the bus daemon's own
`org.freedesktop.DBus` object.

`msg` fields:

| field         | type        |                                                       |
| ------------- | ----------- | ----------------------------------------------------- |
| `destination` | `string`    | bus name to call                                      |
| `path`        | `string`    | object path                                           |
| `interface`   | `string`    | interface name                                        |
| `member`      | `string`    | method name                                           |
| `signature`   | `string`    | signature of `body`; omit when there are no arguments |
| `body`        | `unknown[]` | the arguments                                         |
| `type`        | `number`    | defaults to `messageType.methodCall`                  |
| `flags`       | `number`    |                                                       |

`options`:

| option    | type          |                                                              |
| --------- | ------------- | ------------------------------------------------------------ |
| `timeout` | `number`      | ms to wait; `0` disables. Defaults to the client's `timeout` |
| `signal`  | `AbortSignal` | cancels the call; rejects with `AbortError`                  |

A timeout or an abort **removes the pending call**, so neither leaks an entry
nor delivers a late reply. There is no default timeout: a call waits forever
unless you ask otherwise.

```js
await bus.invoke(msg, { timeout: 5000 });
await bus.invoke(msg, { signal: AbortSignal.timeout(5000) });
```

### Bus daemon methods

Each takes an optional trailing callback and otherwise returns a thenable.

| method                                 | resolves with |
| -------------------------------------- | ------------- |
| `bus.getId()`                          | `string`      |
| `bus.listNames()`                      | `string[]`    |
| `bus.listActivatableNames()`           | `string[]`    |
| `bus.requestName(name, flags)`         | `number`      |
| `bus.releaseName(name)`                | `number`      |
| `bus.nameHasOwner(name)`               | `boolean`     |
| `bus.getNameOwner(name)`               | `string`      |
| `bus.startServiceByName(name, flags)`  | `number`      |
| `bus.updateActivationEnvironment(env)` | —             |
| `bus.getConnectionUnixUser(name)`      | `number`      |
| `bus.getConnectionUnixProcessId(name)` | `number`      |
| `bus.addMatch(rule)`                   | —             |
| `bus.removeMatch(rule)`                | —             |

### Signals

Signals are delivered on `bus.signals`, an `EventEmitter`, keyed by a mangled
`path + interface + member` string. Tell the daemon you want them first with a
match rule:

```js
await bus.addMatch(
  "type='signal',path='/org/example',interface='org.example.Iface',member='Pinged'"
);
const key = bus.mangle('/org/example', 'org.example.Iface', 'Pinged');
bus.signals.on(key, (body, signature) => console.log(body));
```

`bus.mangle(path, interface, member)` or `bus.mangle(msg)` produces the key.

The [proxy API](#proxy-api) wraps both steps — `iface.on('Pinged', handler)`
adds the match rule for you.

### File descriptors

`h` (`UNIX_FD`) is a **uint32 index**, not a descriptor — "the value is an index
into the array of file descriptors that accompany the message", per the
specification. The descriptors themselves travel as ancillary data
(`SCM_RIGHTS`) beside the bytes, and ride on `msg.fds`:

```js
bus.connection.message({
  destination: 'org.example.Sink',
  path: '/org/example/Sink',
  interface: 'org.example.Sink',
  member: 'Take',
  signature: 'sh',
  body: ['a name', 0], //        ^ index into fds
  fds: [fd]
});
```

and the same shape arrives:

```js
bus.connection.on('message', msg => {
  if (msg.fds) console.log(msg.fds[msg.body[1]]);
});
```

**Node has no ancillary-data API**, so nothing here provides a transport that
can carry them — [nodejs/node#53391](https://github.com/nodejs/node/issues/53391)
is closed as not planned, and every addon that does needs a compiler on every
install, which is the property this package spent three releases acquiring. See
[ROADMAP.md §2.8](../ROADMAP.md) for what was measured.

**So the capability is a seam on the stream.** Supply your own transport as
`opts.stream` implementing two things, and everything above it works:

| on the stream              |                                                     |
| -------------------------- | --------------------------------------------------- |
| `writeWithFds(bytes, fds)` | write, carrying descriptors; returns like `write()` |
| `emit('fds', fds)`         | descriptors received, in arrival order              |

`test/utils/fd-transport.js` is a working example, minus the kernel.

| on the connection          |                                                |
| -------------------------- | ---------------------------------------------- |
| `connection.canPassFds`    | whether the transport declared the capability  |
| `connection.unixFdsAgreed` | whether the _peer_ agreed during the handshake |

Both must be true before a descriptor gets anywhere. `NEGOTIATE_UNIX_FD` is only
sent when the transport can carry one — claiming the capability and then failing
on the first `h` would leave the peer with no way to know to use a different
call.

Three details that matter if you write a transport:

- **Descriptors must arrive in the same order as their bytes.** That is what
  lets each message take the number its `UNIX_FDS` header claims, which is how
  libdbus does it too. `SCM_RIGHTS` gives this for free.
- **An fd-carrying message is never batched.** Ancillary data attaches to a
  _write_, not to a message, so a batched one would hand its descriptors to
  whichever message the kernel associated them with. Such a message flushes the
  cork and goes on its own.
- **Ownership is yours.** Nothing here dups or closes anything; a received
  descriptor is a live fd in your process and closing it is your job.

### Scoped resources

A match rule is the thing people forget to remove. A process that adds them and
never removes them has the bus deliver steadily more traffic to it, for signals
nothing is still listening for. `bus.watch()` and `bus.ownName()` hand back
something that releases itself:

```js
const sub = await bus.watch("type='signal',interface='org.example.Iface'");
// …
await sub.remove();

const reg = await bus.ownName('com.example.Greeter');
if (!reg.isPrimaryOwner) console.log('queued behind', reg.result);
await reg.release();
```

Both implement `Symbol.asyncDispose`, as does the bus itself and the raw
connection, so on Node 24+ the language can do it:

```js
await using bus = dbus.sessionBus();
await using reg = await bus.ownName('com.example.Greeter');
await using sub = await bus.watch(
  "type='signal',interface='org.example.Iface'"
);
```

or with `AsyncDisposableStack`, which is the shape of a whole service:

```js
await using stack = new AsyncDisposableStack();
const bus = stack.use(dbus.sessionBus());
stack.use(await bus.ownName('com.example.Greeter'));
stack.use(await bus.watch("type='signal',interface='org.example.Iface'"));
// everything unwinds in reverse, whether the scope ends normally or throws
```

**The protocol works on every supported Node; the syntax does not.**
`Symbol.asyncDispose` is available from Node 20, so `await x[Symbol.asyncDispose]()`
and the `close()`/`remove()`/`release()` methods work on the whole supported
range. `AsyncDisposableStack` and the `using` keyword need Node 24 — that is
the consumer's choice, not a floor this package imposes.

`bus.close()` resolves once the connection is really closed, by which point
every in-flight call has been failed with `ConnectionClosedError` rather than
left waiting. Messages already sent are flushed on the way out. It is
idempotent and safe on a connection that has already gone.

It deliberately does **not** remove match rules or release names first: the bus
drops both when the connection goes, so unwinding them by hand would be round
trips whose only effect is a slower shutdown. Scope them individually when they
need to end _before_ the connection does — which is the case that matters.

### Properties

| property         |                                                           |
| ---------------- | --------------------------------------------------------- |
| `bus.connection` | the underlying [`DBusConnection`](#connection-low-level)  |
| `bus.name`       | this client's unique name, once `Hello` has been answered |
| `bus.signals`    | `EventEmitter` for incoming signals                       |

---

## Proxy API

Introspects a remote object and builds a JavaScript object from it.

### `bus.proxy()`

The short way. Resolves each member against what the object actually declares,
so you do not have to know which interface it lives on:

```js
const notifications = await bus.proxy(
  'org.freedesktop.Notifications',
  '/org/freedesktop/Notifications'
);

const id = await notifications.Notify('app', 0, '', 'hi', '', [], {}, 5000);
notifications.$on('NotificationClosed', (id, reason) => {});

await notifications.$props.$all();
await notifications.$props.$set('Volume', 0.5);
```

| member                     |                                             |
| -------------------------- | ------------------------------------------- |
| `proxy.Member(...)`        | call it, wherever it is declared            |
| `proxy.$props.Name`        | read a property — a promise                 |
| `proxy.$props.$all()`      | every readable property, in one `GetAll`    |
| `proxy.$props.$set(n, v)`  | write one, or an object of several          |
| `proxy.$on/$once/$off`     | signals, wherever they are declared         |
| `proxy.$as(interfaceName)` | the underlying interface, for anything else |
| `proxy.$service`, `$path`  | what it stands for                          |
| `proxy.$interfaces`        | the interfaces it dispatches across         |
| `proxy.$nodes`             | child object paths                          |

**Everything the proxy adds is `$`-prefixed**, and that is a guarantee rather
than a convention: a D-Bus member name matches `[A-Za-z_][A-Za-z0-9_]*`, so `$`
is an impossible first character and nothing can collide.

**An ambiguous member throws, naming both interfaces.** Two interfaces on one
object may declare the same member, and picking one silently would send the
call to whichever introspected first. Narrow it:

```js
const player = await bus.proxy(
  'org.mpris.MediaPlayer2.vlc',
  '/org/mpris/MediaPlayer2',
  {
    interface: 'org.mpris.MediaPlayer2.Player'
  }
);
```

**`proxy.then` is always `undefined`**, even if the service really does declare
a member called `then` — reach that one through `$as()`. A proxy that answered
`then` with a function would make `await proxy` call it and wait forever for a
resolve that never comes. Since `bus.proxy()` is itself async, that hang would
happen at construction rather than at first use.

**Assignment is refused**, for properties and members alike. `obj.x = v`
evaluates to `v` rather than to a promise, so a failed write would be silently
lost; `$props.$set()` can be awaited.

`console.log(proxy)` prints what it stands for and what it can do, rather than
walking the connection:

```
DBusProxy com.example.Proxy /com/example/Proxy
  methods: Add, Echo, Get, GetAll, GetMachineId, Introspect, Ping, Set
  properties: Greeting, Level
  signals: Pinged, PropertiesChanged
```

### The explicit form

Still there, and what `proxy()` is built on. Use it when you want one named
interface and nothing else:

```js
const iface = await bus
  .getService('org.freedesktop.Notifications')
  .getInterface(
    '/org/freedesktop/Notifications',
    'org.freedesktop.Notifications'
  );

await iface.Notify('app', 0, '', 'summary', 'body', [], {}, 5000);
```

| call                                                         | returns                     |
| ------------------------------------------------------------ | --------------------------- |
| `bus.getService(name)`                                       | `DBusService` (synchronous) |
| `service.getObject(objectPath[, cb])`                        | `DBusObject`                |
| `service.getInterface(objectPath, ifaceName[, cb])`          | `DBusInterface`             |
| `bus.getObject(serviceName, objectPath[, cb])`               | `DBusObject`                |
| `bus.getInterface(serviceName, objectPath, ifaceName[, cb])` | `DBusInterface`             |

Note the argument order on the `bus.*` forms: service name first, then object
path.

### DBusObject

| member              |                                                              |
| ------------------- | ------------------------------------------------------------ |
| `obj.name`          | the object path — always the one you asked for               |
| `obj.service`       | the owning `DBusService`                                     |
| `obj.proxy`         | every introspected interface, by name                        |
| `obj.nodes`         | the names of the child objects, relative to this path        |
| `obj.as(ifaceName)` | one interface — **throws `UnknownInterfaceError`** if absent |

A path that groups other objects and implements nothing itself — a container,
like `/org/freedesktop/UPower/devices` — comes back with an empty `proxy` and
its children in `nodes`. Walk down from there:

```js
const container = await service.getObject('/com/example/Devices');
for (const child of container.nodes) {
  const device = await service.getObject(`/com/example/Devices/${child}`);
}
```

> Before 0.12 such a path was silently replaced by its **first child**: you got
> a proxy for `/com/example/Devices/<first>` while believing you had the
> container, calls went to an object you never named, and the other children
> were dropped. Asking a container for an interface now throws
> `UnknownInterfaceError`, and the message names the children.

### DBusInterface

**Methods** are functions taking the method's arguments, plus an optional
callback:

```js
const result = await iface.Echo('hi');
iface.Echo('hi', (err, result) => {});
```

**Properties** are read by _calling_ the accessor, and written by assignment:

```js
const greeting = await iface.Greeting(); // read
iface.Greeting = 'hello'; // write, fire-and-forget
await iface.$writeProp('Greeting', 'hello'); // write, awaitable
await iface.$readProp('Greeting'); // read, explicit
```

Assignment cannot be awaited, so a failed write has nowhere to report. Use
`$writeProp` when you need to know it succeeded.

**Signals** use the `EventEmitter` methods, and add the match rule for you:

```js
iface.on('ActionInvoked', (...args) => {});
iface.once('ActionInvoked', handler); // fires at most once, then unsubscribes
iface.off('ActionInvoked', handler); // removes the match rule when the last listener goes
iface.removeAllListeners('ActionInvoked'); // or with no argument, every signal
iface.listenerCount('ActionInvoked');
```

`on`/`once`/`off` return the interface, so they chain.

Installing the match rule is a round trip to the daemon, and `on` cannot report
when it finishes or that it failed. `$subscribe`/`$unsubscribe` do both:

```js
// resolved => the daemon is routing the signal to us
await iface.$subscribe('ActionInvoked', handler);
await iface.$unsubscribe('ActionInvoked', handler);
```

Prefer them when you are about to trigger whatever emits the signal, or when
`AddMatch` failing is something you want to catch — from `on` it surfaces as a
connection `handlerError` instead.

**`$signals`** lists what the interface declared, in the same
`[signature, ...argumentNames]` shape a service is exported with:

```js
iface.$signals; // { ActionInvoked: ['su', 'id', 'action'] }
```

---

## Exporting a service

```js
const ifaceDesc = {
  name: 'com.example.Iface',
  methods: {
    // name: [inputSignature, outputSignature, inputNames, outputNames]
    Echo: ['s', 's', ['input'], ['output']]
  },
  signals: {
    // name: [signature, ...argumentNames]
    Pinged: ['s', 'payload']
  },
  properties: {
    // a signature alone means readwrite
    Greeting: 's',
    // or declare the access explicitly
    Locked: { type: 'b', access: 'read' },
    Secret: { type: 's', access: 'write' }
  }
};

const impl = Object.assign(Object.create(EventEmitter.prototype), {
  Greeting: 'hello',
  Echo: input => input
});
EventEmitter.call(impl);

await bus.requestName('com.example.Service', 0);
bus.exportInterface(impl, '/com/example/Object', ifaceDesc);

impl.emit('Pinged', 'payload'); // emits the d-bus signal too
```

A method implementation may return a value, a promise, or throw. A thrown
error becomes an error reply, using `err.dbusName` if set and
`org.freedesktop.DBus.Error.Failed` otherwise. Returning `null` sends a reply
with no body.

### What a method returns

One value per complete type in the output signature:

| output signature | complete types | the handler returns                 |
| ---------------- | -------------- | ----------------------------------- |
| `''`             | 0              | anything; no reply body is sent     |
| `'s'`            | 1              | the value — `'hello'`               |
| `'(si)'`         | 1 (a struct)   | one array — `['name', 3]`           |
| `'si'`           | 2              | an array of the two — `['name', 3]` |
| `'ssss'`         | 4              | an array of the four                |

`'(si)'` and `'si'` take the same JavaScript value and mean different things on
the wire: one struct, versus two separate arguments. Which you want depends on
the interface you are implementing — `org.freedesktop.Notifications`'s
`GetServerInformation`, for instance, declares four separate out arguments.

Returning the wrong shape produces an error reply naming the method and the
signature it declared, rather than taking the service down:

```
org.freedesktop.DBus.Error.Failed: com.example.Iface.GetInfo returned a value
that does not match its declared output signature "ssss": …
```

`exportInterface` monkey-patches `impl.emit` so a local emit also sends the
signal. `org.freedesktop.DBus.Introspectable`, `.Properties` and `.Peer` are
answered for you.

### Property access

`access` defaults to `readwrite`, which is what a bare signature has always
meant. It is advertised in the introspection XML and enforced:

|                     | `read`             | `write`        | `readwrite` |
| ------------------- | ------------------ | -------------- | ----------- |
| `Properties.Get`    | ✓                  | `AccessDenied` | ✓           |
| `Properties.Set`    | `PropertyReadOnly` | ✓              | ✓           |
| `Properties.GetAll` | included           | omitted        | included    |

### PropertiesChanged

`Properties.Set` emits `org.freedesktop.DBus.Properties.PropertiesChanged` for
you. A write-only property is reported as _invalidated_ rather than broadcast,
since there is no value subscribers are allowed to see.

When the service changes a property itself, say so — an ordinary assignment to
the implementation object cannot be observed:

```js
impl.Greeting = 'hello again';
bus.emitPropertiesChanged(path, iface.name, { Greeting: impl.Greeting });
```

`emitPropertiesChanged(path, interfaceName, changed, invalidated?)` takes
signatures from the interface descriptor, so values are marshalled as declared
rather than guessed from their JS type. It throws if the interface is not
exported at that path, or if a named property is not declared on it.

**Receiving one** is a subscription on `org.freedesktop.DBus.Properties`, not on
the interface that owns the property — the signal names that interface in its
first argument:

```js
const props = await bus
  .getService(name)
  .getInterface(path, 'org.freedesktop.DBus.Properties');

await props.$subscribe(
  'PropertiesChanged',
  (interfaceName, changed, invalidated) => {
    for (const [prop, value] of changed) {
      console.log(prop, variantValue(value));
    }
  }
);
```

`changed` is an `a{sv}`, so until 2.0 it is an array of pairs whose values are
variants — see [Values and types](#values-and-types) and use `variantValue()` so
the code survives the change.

The `invalidated` list names properties whose value changed but is not being
sent — write-only ones, or anything expensive to compute. Listing them tells a
subscriber to re-read rather than keep a stale value:

```js
bus.emitPropertiesChanged(path, iface.name, {}, ['Expensive']);
```

Lower-level pieces, if you are not using `exportInterface`:

| method                                                                |                              |
| --------------------------------------------------------------------- | ---------------------------- |
| `bus.sendSignal(path, iface, name, signature, args)`                  | emit a signal                |
| `bus.sendReply(msg, signature, body)`                                 | reply to a method call       |
| `bus.sendError(msg, errorName, errorText)`                            | error-reply to a method call |
| `bus.setMethodCallHandler(path, iface, member, [handler, signature])` | handle one member            |

### Publishing a tree: ObjectManager

`org.freedesktop.DBus.ObjectManager` is how a service with many objects lets a
client fetch all of them, with their properties, in one round trip — and get
told when they come and go. BlueZ, NetworkManager, systemd and UDisks all use
it, so it is how "list the devices" is spelled on a real bus.

```js
bus.exportObjectManager('/com/example');

bus.exportInterface(hci0, '/com/example/dev0', deviceIface); // InterfacesAdded
bus.exportInterface(hci1, '/com/example/dev1', deviceIface); // InterfacesAdded

bus.unexportInterface('/com/example/dev1'); // InterfacesRemoved
```

That is the whole API. `GetManagedObjects` is answered for you, the interface
appears in the introspection XML at the manager path, and the two signals are
emitted as objects are exported and unexported.

| method                                         |                                         |
| ---------------------------------------------- | --------------------------------------- |
| `bus.exportObjectManager(path)`                | serve ObjectManager at `path`           |
| `bus.unexportInterface(path[, interfaceName])` | stop serving an object or one interface |

Four things worth knowing:

- **A manager reports what is strictly below it**, never itself. This is why
  BlueZ's manager is at `/` and reports `/org/bluez/hci0`.
- **Opt-in.** A path only manages a tree if you say so — a client has no way to
  know it can call `GetManagedObjects` unless the interface is advertised, and
  answering everywhere would claim a tree at any path someone asked about.
- **Managers may nest.** The deepest one containing an object is the one that
  announces it, so `/` and `/com/example` can both be managers without every
  signal arriving twice at the root.
- **`InterfacesAdded` announces only what appeared.** Re-exporting one interface
  on an object that already had three is not news about the other three.

Write-only properties are omitted from the reply, exactly as `GetAll` omits
them: there is no value to report and the spec says to leave it out.

`unexportInterface` returns whether anything was removed, and an object whose
last interface goes stops existing rather than lingering as a path with nothing
on it.

### Watching one: `bus.objects()`

The client side. `GetManagedObjects` returns `a{oa{sa{sv}}}` — three levels of
dict with variants at the bottom — and then you have to keep it current from
three different signals, matched against the right service. Everyone using
BlueZ or NetworkManager writes this, and writes it slightly wrong.

```js
const bluez = await bus.objects('org.bluez', '/');

bluez.filter('org.bluez.Device1');
// { '/org/bluez/hci0/dev_AA': { Alias: 'Headphones', Connected: false } }

bluez.on('added', (path, interfaces) => {});
bluez.on('removed', (path, interfaceNames) => {});
bluez.on('changed', (path, iface, changed, invalidated) => {});

await bluez.close();
```

| member                       |                                                        |
| ---------------------------- | ------------------------------------------------------ |
| `view.objects`               | `{ path: { interface: { property: value } } }`         |
| `view.paths()`               | every managed path                                     |
| `view.get(path)`             | one object's interfaces, or `undefined`                |
| `view.filter(interfaceName)` | `{ path: properties }` for objects implementing it     |
| `view.owner`                 | the unique name currently owning the service           |
| `view.close()`               | remove the match rules and stop listening — idempotent |

It also implements `Symbol.asyncDispose`, so the match rules — the resource
people forget — can be scoped rather than released by hand:

```js
await using bluez = await bus.objects('org.bluez', '/');
```

**Values are plain in every connection shape.** A view whose contents depended
on `plainValues` would be useless to write against.

**It subscribes before it fetches.** Fetching first leaves a window where an
object appears, its `InterfacesAdded` goes nowhere, and the view is permanently
missing it. Signals arriving during startup are buffered and replayed onto the
snapshot.

**`PropertiesChanged` is tracked too**, so a value stays current and not just
the set of objects. Pass `{ properties: false }` to skip it and the match rule
it costs. An invalidated property is _dropped_ from the view rather than left
at its old value — keeping a value the service has disowned is how a view
starts lying; re-read it with `Properties.Get`.

**A `'stale'` event fires if the service is replaced or goes away.** The view
does not resynchronise itself: re-fetching would race whatever the caller is
doing with it, and a half-updated tree is worse than a stale one that says so.
Make a new view.

If you only want the snapshot, the raw call is fine — just reach for
`toPlain()`, because three levels of pairs is not readable:

```js
const objects = toPlain(await bus.invoke({/* GetManagedObjects */}));
// { '/com/example/dev0': { 'com.example.Device': { Name: 'hci0' } } }
```

---

## Connection (low-level)

`dbus.createConnection(opts)` gives the transport with no `MessageBus` on it.
`bus.connection` is the same object.

```js
const conn = dbus.createConnection();
conn.message({
  path: '/org/freedesktop/DBus',
  destination: 'org.freedesktop.DBus',
  interface: 'org.freedesktop.DBus',
  member: 'Hello',
  type: dbus.messageType.methodCall
});
conn.on('message', msg => console.log(msg));
```

| member              |                                                                 |
| ------------------- | --------------------------------------------------------------- |
| `conn.message(msg)` | write a message; returns `false` when the socket buffer is full |
| `conn.end()`        | close the connection                                            |
| `conn.stream`       | the underlying `Duplex`                                         |
| `conn.guid`         | the peer's GUID, after the handshake                            |

`message()` follows the [`stream.write()`](https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback)
convention. A fast producer must stop on `false` and resume on `'drain'`, or
messages queue in memory without bound:

```js
if (!conn.message(msg)) {
  await new Promise(resolve => conn.once('drain', resolve));
}
```

Messages written in the same tick are batched into one socket write.

### Events

| event          | argument  |                                                                          |
| -------------- | --------- | ------------------------------------------------------------------------ |
| `connect`      | —         | authentication succeeded                                                 |
| `message`      | `Message` | a message arrived                                                        |
| `drain`        | —         | the write buffer emptied; safe to resume                                 |
| `end`          | —         | the peer hung up                                                         |
| `close`        | `Error?`  | the transport is fully torn down; pending calls have already been failed |
| `error`        | `Error`   | transport or protocol failure                                            |
| `handlerError` | `Error`   | an exception thrown by one of _your_ `message`/signal listeners          |

A protocol error — a malformed or oversized message — is unrecoverable, so the
connection is destroyed after `error` is emitted. `handlerError` is separate
because it is an application bug rather than a connection failure, and the
connection stays usable; if nothing is listening for it, the exception is
re-thrown asynchronously, matching Node's default for a throwing listener.

`messageType`: `{ invalid: 0, methodCall: 1, methodReturn: 2, error: 3, signal: 4 }`.

---

## Values and types

### Type mapping

| D-Bus          | code    | JavaScript                                                                                        |
| -------------- | ------- | ------------------------------------------------------------------------------------------------- |
| byte           | `y`     | `number`                                                                                          |
| boolean        | `b`     | `boolean`                                                                                         |
| int16 / uint16 | `n` `q` | `number`                                                                                          |
| int32 / uint32 | `i` `u` | `number`                                                                                          |
| int64 / uint64 | `x` `t` | `number`, lossy above 2⁵³ — `bigint` with `returnBigInt`, or Long.js with `ReturnLongjs`          |
| double         | `d`     | `number`                                                                                          |
| string         | `s`     | `string`                                                                                          |
| object path    | `o`     | `string`                                                                                          |
| signature      | `g`     | `string`                                                                                          |
| array          | `a`     | `Array`                                                                                           |
| byte array     | `ay`    | `Buffer` — see `ayBuffer`                                                                         |
| struct         | `()`    | `Array`                                                                                           |
| dict           | `a{}`   | read: `Array` of `[key, value]` pairs · write: that, **or a plain object**                        |
| variant        | `v`     | read: `[parsedSignature, [value]]` · write: `Variant`, `[signature, value]`, or either read shape |

`h` (UNIX_FD) is not supported.

Two of these are awkward, and both change in 2.0 — see
[docs/deprecations.md](./deprecations.md). Read them through the helpers below
and your code survives that change untouched.

**Writing** 64-bit values accepts a `number` up to 53 bits, a decimal or
`0x`-prefixed string for the full range, or a Long.js object.

### Writing a dict as a plain object

Anywhere a dict is expected, a plain object will do:

```js
await iface.SetOptions({ Name: 'widget', Count: 3, Enabled: true });

// the same thing, spelled out
await iface.SetOptions([
  ['Name', new Variant('s', 'widget')],
  ['Count', new Variant('i', 3)],
  ['Enabled', new Variant('b', true)]
]);
```

Both write identical bytes. The array-of-pairs form is unchanged, and nothing
about it infers — only values reached through a plain object do.

Inside an object, the signature of an `a{sv}` value is inferred:

| JavaScript              | inferred           |
| ----------------------- | ------------------ |
| `string`                | `s`                |
| `boolean`               | `b`                |
| integer within int32    | `i`                |
| integer outside int32   | `x`                |
| any other `number`      | `d`                |
| `bigint`                | `x`                |
| `Buffer` / `TypedArray` | `ay`               |
| `Array` (homogeneous)   | `a` + element type |
| plain object            | `a{sv}`            |

`Variant` overrides it, and is how you reach the types inference does not
produce — `u`, `y`, `o`, `g`, structs, `av`:

```js
await iface.SetOptions({ Count: new Variant('u', 3) }); // uint32, not int32
```

Two things to know:

- **Inside an object an array is an array**, never a `[signature, value]` pair.
  `{ v: ['s', 'hello'] }` is an array of two strings; use
  `new Variant('s', 'hello')` for an explicitly typed value.
- **Inference refuses to guess** rather than picking something arbitrary: an
  empty array, a mixed array, `null`, `undefined`, `NaN` and anything it does
  not recognise all throw, naming what to do instead. A d-bus array is
  homogeneous, so `[1, 'a']` has no signature.

A class instance is not treated as a dict — only objects whose prototype is
`Object.prototype` or `null`. Being wrong about that would write a garbled
message instead of failing.

### Reading the 2.0 shapes today: `plainValues`

The awkward half of the type system is on the **read** side, and it changes in
2.0. `plainValues: true` gives you that shape now, so code can be migrated on a
released version instead of on a flag day — the same path `returnBigInt` took:

```js
const bus = dbus.sessionBus({ plainValues: true });
```

| signature | default                         | `plainValues`               |
| --------- | ------------------------------- | --------------------------- |
| `v`       | `[signatureTree, [value]]`      | `value`                     |
| `a{sv}`   | array of pairs, values variants | `{ key: value }`            |
| `a{ss}`   | array of pairs                  | `{ key: value }`            |
| `a{us}`   | array of pairs                  | **unchanged** — see below   |
| `a(ss)`   | array of arrays                 | unchanged, it is not a dict |

Reading only. The marshaller already takes plain objects and `Variant`, so a
value read this way can be written straight back out — including passing one
from one service to another.

**A dict whose keys are not strings stays as pairs.** A JavaScript object key is
always a string, so `a{us}` read as an object would turn the key `1` into `'1'`,
and with `returnBigInt` a 64-bit key would stringify and lose precision on the
way back. Quiet corruption is worse than an inconvenient shape.

**Reading a variant this way discards its signature** — `variantSignature()`
returns `undefined` for it. That is usually what you want, and when it is not,
see `variants` below.

Both sides of a conversation should agree: a service reads its own method
arguments through the same parser, so set it there too.

`variantValue()` and `toPlain()` read either shape and become the identity under
this one, so code written against them needs no change when the default flips.

### Getting the type back: `variants`

Sometimes the value is not enough. A tool that prints a reply has to say
`variant u 501` rather than `501`, and a service handed an `a{sv}` may need to
know what its caller actually sent. Both used to mean reading the parser's
internal tree, which is the thing 2.0 exists to stop.

`variants` decides how a `v` comes back, independently of the dict shape:

| value     | a `v` reads as             | `variantSignature()` |
| --------- | -------------------------- | -------------------- |
| `'tree'`  | `[signatureTree, [value]]` | the signature        |
| `'plain'` | `value`                    | `undefined`          |
| `'wrap'`  | `Variant(sig, value)`      | the signature        |

It defaults to `'plain'` when `plainValues` is set and `'tree'` otherwise, so
existing code is unaffected either way.

```js
const bus = dbus.sessionBus({ plainValues: true, variants: 'wrap' });

const props = await iface.$readProp('Metadata');
props.Volume.signature; // 'd'
props.Volume.value; // 0.5
variantValue(props.Volume); // 0.5 -- the accessors understand it
```

That combination — plain dicts whose values still carry their types — is what
`dbus-native call` uses, and it is the recommended shape for anything that
inspects or forwards values rather than just consuming them.

A `Variant` is a better carrier than the tree in three ways: it prints as
`Variant('u', 501)` instead of a wall of parse-tree objects, `variantValue()`
and `toPlain()` already read it, and **the marshaller accepts it**, so a value
read this way can be sent straight back out without unwrapping. The tree could
do none of those.

The signature is the one the sender wrote, never one re-derived from the value:
`y`, `n`, `q`, `i`, `u` and `d` all arrive as a JavaScript number, so inferring
it back would be a guess presented as type information.

---

A variant read off the wire can also be written straight back, so a value can
be passed from one service to another without unwrapping it:

```js
const opts = await source.GetOptions();
await sink.SetOptions(opts); // the [parsedSignature, [value]] shape is accepted
```

**`ayBuffer`** controls byte arrays: `true` (default) copies into a `Buffer`;
`'view'` returns a `Buffer` sharing memory with the message, which avoids the
copy but keeps the whole message alive for as long as you hold the value — a
4-byte `ay` from a 4 MB message pins 4 MB; `false` gives a plain array of
numbers.

### Helpers

```js
const {
  Variant,
  variantValue,
  variantSignature,
  toPlain
} = require('dbus-native');
```

| function                        |                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `variantValue(v)`               | the value inside a variant, in either the current or the 2.0 shape; identity on a plain value |
| `variantSignature(v)`           | the variant's signature, or `undefined` once flattened                                        |
| `toPlain(v)`                    | recursively: dicts to objects, variants unwrapped; no-op on plain values                      |
| `new Variant(signature, value)` | an explicitly typed value, for writing                                                        |

```js
const udi = variantValue(entry); // today: entry[1][0];  2.0: entry
const props = toPlain(dict); // today: array of pairs;  2.0: identity

bus.invoke({
  /* … */ signature: 'ssv',
  body: [iface, 'Greeting', new Variant('s', 'hello')]
});
```

`toPlain` only converts arrays the parser tagged as dicts, so `a(ss)` — an
array of two-string structs — is left alone. A shape-based heuristic cannot
tell those two apart, which is why the parser tags them rather than guessing.

---

## Names

Object paths, interface names, error names, member names and bus names each
have their own rules in the
[specification](https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names),
and they are easy to confuse:

| kind           | shape                                              | notes                                   |
| -------------- | -------------------------------------------------- | --------------------------------------- |
| object path    | `/`, or `/`-separated `[A-Za-z0-9_]` elements      | elements may start with a digit; no `.` |
| interface name | two or more `.`-separated `[A-Za-z_][A-Za-z0-9_]*` | no `-`, no leading digit, ≤ 255 bytes   |
| error name     | as interface names                                 |                                         |
| member name    | one `[A-Za-z_][A-Za-z0-9_]*` element               | no dots, ≤ 255 bytes                    |
| bus name       | `:1.23`, or an interface name that may contain `-` | ≤ 255 bytes                             |

Property names are the odd one out: the specification does not give them a rule
at all. A method or signal name is a header field the bus itself parses, but a
property name is only ever a string _argument_ to `Properties.Get`/`Set`, and
the introspection DTD declares the attribute as `CDATA`. So a property may
additionally contain `-`, which is the GObject convention and which GDBus,
sd-bus and python-dbus all read and write without complaint:

| kind          | shape                                 | notes                              |
| ------------- | ------------------------------------- | ---------------------------------- |
| property name | one `[A-Za-z_][A-Za-z0-9_-]*` element | member name, plus `-`; ≤ 255 bytes |

The rest of the member charset is kept so the name needs no escaping in the
introspection XML, and so typos — a space, a dot, a stray quote — are still
caught.

These are enforced on what you **send**, because an invalid name produces a
message no peer can route — and for a signal, which gets no reply, that fails
silently:

| where                   | checks                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `bus.exportInterface()` | the path, `iface.name`, every method and signal name, and every property name against the looser rule above |
| `bus.sendSignal()`      | the interface and member name                                                                               |
| `bus.sendError()`       | the error name                                                                                              |
| marshalling an `o`      | the object path, including every message's path                                                             |

All of them throw an `Error` naming the rule that was broken. Incoming names
are not checked — be strict in what you send, lenient in what you accept.

The predicates are exported for names built at runtime, where checking beats
catching:

```js
const { isValidInterfaceName, isValidObjectPath } = require('dbus-native');

if (!isValidObjectPath(`/com/example/${deviceId}`)) {
  // a device id with a '-' in it would be rejected at export
}
```

`isValidObjectPath`, `isValidInterfaceName`, `isValidErrorName`,
`isValidMemberName`, `isValidPropertyName` and `isValidBusName` all take any
value and return a boolean.

---

## Errors

Every failure is an `Error`. All of these extend `DBusError`, which extends
`Error`.

| class                   | raised when                                    | `code`        |
| ----------------------- | ---------------------------------------------- | ------------- |
| `DBusError`             | the call returned an error reply               | —             |
| `TimeoutError`          | no reply within the timeout                    | `ETIMEDOUT`   |
| `AbortError`            | cancelled through an `AbortSignal`             | `ABORT_ERR`   |
| `ConnectionClosedError` | the connection went away with the call pending | `ECONNCLOSED` |
| `UnknownInterfaceError` | the object does not implement that interface   | —             |

| property       |                                                                 |
| -------------- | --------------------------------------------------------------- |
| `err.message`  | the error text, or the D-Bus error name when the body was empty |
| `err.dbusName` | e.g. `org.freedesktop.DBus.Error.ServiceUnknown`                |
| `err.body`     | the raw reply arguments                                         |
| `err.reply`    | the full reply message                                          |

```js
try {
  await iface.Method();
} catch (err) {
  if (err.dbusName === 'org.freedesktop.DBus.Error.ServiceUnknown') {
    /* … */
  }
  if (err instanceof dbus.TimeoutError) {
    /* … */
  }
}
```

`TimeoutError` and `AbortError` both carry
`dbusName: 'org.freedesktop.DBus.Error.NoReply'`, so code switching on
`dbusName` treats a local timeout and a remote no-reply the same way.
`AbortError.cause` is the signal's reason.

Before 0.7 a failed call delivered the raw message body array —
[docs/migrating-to-0.7.md](./migrating-to-0.7.md), and
`require('dbus-native/compat').toClassicError(err)` reconstructs it.

---

## Diagnostics

Instrumented through [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html),
so it costs nothing when nobody is subscribed.

| channel name to subscribe to | payload                                        |
| ---------------------------- | ---------------------------------------------- |
| `dbus:message:send`          | `{ message }` — every message written          |
| `dbus:message:receive`       | `{ message }` — every message read             |
| `tracing:dbus:call:start`    | the call context (below)                       |
| `tracing:dbus:call:end`      | the same context, now with `result` or `error` |
| `tracing:dbus:call:error`    | the same context, with `error`                 |

The call context is
`{ destination, path, interface, member, signature, result?, error? }`, and is
the _same object_ across `start` and `end`, so it can be used as a `Map` key
to time a call.

The `tracing:` prefix is Node's, not ours — `diagnostics_channel.tracingChannel('dbus:call')`
names its channels `tracing:${name}:${event}`.

```js
const dc = require('node:diagnostics_channel');
dc.subscribe('tracing:dbus:call:error', ctx =>
  console.error(`${ctx.member} failed:`, ctx.error.message)
);
```

---

## CLI

| command      |                                                     |
| ------------ | --------------------------------------------------- |
| `call`       | call a method, the way `dbus-send` does             |
| `get`, `set` | read or write a property                            |
| `list`       | the names on the bus                                |
| `types`      | TypeScript declarations for a service               |
| `introspect` | a service's raw introspection XML                   |
| `codemod`    | rewrite your source for a breaking change           |
| `lint`       | report reads of the value shapes that change in 2.0 |

### Talking to the bus

```sh
npx dbus-native list
npx dbus-native call --dest org.freedesktop.DBus \
  /org/freedesktop/DBus org.freedesktop.DBus.ListNames

npx dbus-native get --system --dest org.freedesktop.UPower \
  /org/freedesktop/UPower org.freedesktop.UPower DaemonVersion
```

Arguments use `dbus-send`'s `type:value` form, so a command line you already
have can be pasted in:

| form                                  | signature |
| ------------------------------------- | --------- |
| `string:` `objpath:` `signature:`     | `s o g`   |
| `byte:` `boolean:`                    | `y b`     |
| `int16:` `uint16:` `int32:` `uint32:` | `n q i u` |
| `int64:` `uint64:` `double:`          | `x t d`   |
| `array:string:a,b,c`                  | `as`      |
| `dict:string:uint32:width,800`        | `a{su}`   |
| `variant:int32:42`                    | `v`       |
| `dict:string:variant:urgency,byte:1`  | `a{sv}`   |
| `array:variant:int32:1,string:two`    | `av`      |

`variant` works as a container element type because a `type:value` pair contains
no comma, so each element can carry its own. That matters because `a{sv}` is the
most common dict on the bus — `Notify`'s hints, `Properties.GetAll`,
NetworkManager's settings — and `dbus-send` cannot express it:

```sh
npx dbus-native call --dest org.freedesktop.Notifications \
  /org/freedesktop/Notifications org.freedesktop.Notifications.Notify \
  string:my-app uint32:0 string: string:Summary string:Body \
  array:string: dict:string:variant:urgency,byte:1 int32:2000
```

Each value is range-checked before anything is sent, and the message names the
type you typed rather than the signature character: `256 is out of range for y
(0..255)`. 64-bit values are carried as `BigInt` and printed exactly, in both
directions — a tool for inspecting values must not round them.

For what that form cannot express — a struct, nesting past one level, a value
containing a comma — give the signature and the body directly:

```sh
npx dbus-native call --dest com.example.Service /com/example/Obj \
  com.example.Iface.Configure \
  --signature 'a(si)' --body '[[["first", 1], ["second", 2]]]'
```

Other flags: `--system`, `--address`, `--json` (plain shapes, for a pipeline),
`--timeout`, `--no-reply`, `--no-auto-start`, and for `list`, `--activatable`
and `--all`. A failed call exits non-zero with the error **name** as well as its
text, since `UnknownMethod` and `AccessDenied` want different responses.

### Generating and checking code

```sh
npx dbus-native types --system \
  --service org.freedesktop.NetworkManager \
  --path /org/freedesktop/NetworkManager \
  --out src/generated/network-manager.d.ts

npx dbus-native introspect --service org.example --path /org/example
npx dbus-native codemod errors-to-error-objects --dry src/
npx dbus-native lint src/
```

`lint` exits non-zero when there are findings, so it can gate CI. `--exit-zero`
reports without failing; `--rule DBUS_DEP0002` selects individual codes. It
never rewrites — reading a variant is an index chain and nothing in the source
says what the value is, so it narrows the problem to a reviewed list rather
than guessing. Findings marked `(possible)` are heuristic.

`dbus2js` still exists and is **deprecated** (`DBUS_DEP0005`).

See [the README](../README.md#generating-types-for-a-service) for the full flag
list, and [docs/deprecations.md](./deprecations.md) for every deprecation code.

---

## TypeScript

Types ship with the package; there is no `@types/` to install. They are
hand-written and checked in CI against a usage fixture, so they cannot drift
from the API without the build failing.

```ts
import dbus = require('dbus-native');
import { MessageBus, DBusInterface, DBusError, Variant } from 'dbus-native';
```

`getInterface` takes an optional type argument for a checked remote surface:

```ts
interface Player extends DBusInterface {
  PlayPause(): Promise<void>;
}
const player = await bus
  .getService('org.mpris.MediaPlayer2.vlc')
  .getInterface<Player>(
    '/org/mpris/MediaPlayer2',
    'org.mpris.MediaPlayer2.Player'
  );
```

`dbus-native types` generates those interfaces from a live service.
