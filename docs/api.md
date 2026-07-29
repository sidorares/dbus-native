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
| `dbus.createServer(handler?)`  | `DBusServer`     | **not production infrastructure** — see below                         |

`sessionBus` and `systemBus` are `createClient` with a `busAddress` filled in;
all three take the same options.

> `createServer` exists but `lib/server-handshake.js` is a stub: it replies
> with a hardcoded GUID and cookie and logs to stdout. Do not treat it as
> working infrastructure. `handler` is called with a `DBusConnection` per
> accepted socket, and the returned object has a `listen(...)` delegating to
> `net.Server#listen`.

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
| `ReturnLongjs`   | `boolean`                 | `false`                                         | **deprecated** (`DBUS_DEP0001`) — 64-bit as Long.js            |

Address forms understood by `busAddress`: `unix:path=…`, `unix:abstract=…`,
`unix:socket=…`, `tcp:host=…,port=…`, and `unixexec:path=…,arg1=…`.

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

### Properties

| property         |                                                           |
| ---------------- | --------------------------------------------------------- |
| `bus.connection` | the underlying [`DBusConnection`](#connection-low-level)  |
| `bus.name`       | this client's unique name, once `Hello` has been answered |
| `bus.signals`    | `EventEmitter` for incoming signals                       |

---

## Proxy API

Introspects a remote object and builds a JavaScript object from it.

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
| `obj.name`          | the object path                                              |
| `obj.service`       | the owning `DBusService`                                     |
| `obj.proxy`         | every introspected interface, by name                        |
| `obj.nodes`         | child node paths from the introspection data                 |
| `obj.as(ifaceName)` | one interface — **throws `UnknownInterfaceError`** if absent |

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
iface.off('ActionInvoked', handler); // removes the match rule when the last listener goes
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
    Greeting: 's'
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

`exportInterface` monkey-patches `impl.emit` so a local emit also sends the
signal. `org.freedesktop.DBus.Introspectable`, `.Properties` and `.Peer` are
answered for you.

Lower-level pieces, if you are not using `exportInterface`:

| method                                                                |                              |
| --------------------------------------------------------------------- | ---------------------------- |
| `bus.sendSignal(path, iface, name, signature, args)`                  | emit a signal                |
| `bus.sendReply(msg, signature, body)`                                 | reply to a method call       |
| `bus.sendError(msg, errorName, errorText)`                            | error-reply to a method call |
| `bus.setMethodCallHandler(path, iface, member, [handler, signature])` | handle one member            |

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

| D-Bus          | code    | JavaScript                                                 |
| -------------- | ------- | ---------------------------------------------------------- |
| byte           | `y`     | `number`                                                   |
| boolean        | `b`     | `boolean`                                                  |
| int16 / uint16 | `n` `q` | `number`                                                   |
| int32 / uint32 | `i` `u` | `number`                                                   |
| int64 / uint64 | `x` `t` | `number`, lossy above 2⁵³ — or Long.js with `ReturnLongjs` |
| double         | `d`     | `number`                                                   |
| string         | `s`     | `string`                                                   |
| object path    | `o`     | `string`                                                   |
| signature      | `g`     | `string`                                                   |
| array          | `a`     | `Array`                                                    |
| byte array     | `ay`    | `Buffer` — see `ayBuffer`                                  |
| struct         | `()`    | `Array`                                                    |
| dict           | `a{}`   | `Array` of `[key, value]` pairs                            |
| variant        | `v`     | `[parsedSignature, [value]]`                               |

`h` (UNIX_FD) is not supported.

Two of these are awkward, and both change in 2.0 — see
[docs/deprecations.md](./deprecations.md). Read them through the helpers below
and your code survives that change untouched.

**Writing** 64-bit values accepts a `number` up to 53 bits, a decimal or
`0x`-prefixed string for the full range, or a Long.js object.

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

```sh
npx dbus-native types --system \
  --service org.freedesktop.NetworkManager \
  --path /org/freedesktop/NetworkManager \
  --out src/generated/network-manager.d.ts

npx dbus-native introspect --service org.example --path /org/example
npx dbus-native codemod errors-to-error-objects --dry src/
```

| command      |                                           |
| ------------ | ----------------------------------------- |
| `types`      | TypeScript declarations for a service     |
| `introspect` | a service's raw introspection XML         |
| `codemod`    | rewrite your source for a breaking change |

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
