dbus-native
===========

D-bus protocol client and server for node.js, implemented in pure JavaScript —
no native addons and no build step.

[![CI](https://github.com/sidorares/dbus-native/actions/workflows/ci.yml/badge.svg)](https://github.com/sidorares/dbus-native/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dbus-native.svg)](https://www.npmjs.com/package/dbus-native)

Installation
------------

```shell
npm install dbus-native
```

Requires Node.js 20.8.0 or newer.

Or from a checkout:

```shell
git clone https://github.com/sidorares/dbus-native
cd dbus-native
npm install # install dependencies
sudo cp examples/com.github.sidorares.dbus.Example.conf /etc/dbus-1/system.d/ # if you want to test examples/service.js
```

Usage
------

Short example using desktop notifications service

```js
const dbus = require('dbus-native');
const sessionBus = dbus.sessionBus();
sessionBus
  .getService('org.freedesktop.Notifications')
  .getInterface(
    '/org/freedesktop/Notifications',
    'org.freedesktop.Notifications',
    function (err, notifications) {
      // dbus signals are EventEmitter events
      notifications.on('ActionInvoked', function () {
        console.log('ActionInvoked', arguments);
      });
      notifications.on('NotificationClosed', function () {
        console.log('NotificationClosed', arguments);
      });
      notifications.Notify(
        'exampl',
        0,
        '',
        'summary 3',
        'new message text',
        ['xxx yyy', 'test2', 'test3', 'test4'],
        [],
        5,
        function (err, id) {
          //setTimeout(function() { n.CloseNotification(id, console.log); }, 4000);
        }
      );
    }
  );
```

API
---

### Low level messaging: bus connection

`connection = dbus.createClient(options)`

options:

- socket - unix socket path
- port - TCP port
- host - TCP host
- busAddress - encoded bus address. Default is `DBUS_SESSION_BUS_ADDRESS` environment variable. See http://dbus.freedesktop.org/doc/dbus-specification.html#addresses
- authMethods - array of authentication methods, which are attempted in the order provided (default:['EXTERNAL', 'DBUS_COOKIE_SHA1', 'ANONYMOUS'])
- ayBuffer - `true` (default), `false` or `'view'`: how `ay` (byte array) fields
  are returned.
  - `true` returns a `Buffer` holding its own copy of the bytes.
  - `'view'` returns a `Buffer` that shares memory with the received message.
    This avoids a copy, but the whole message stays in memory for as long as
    you hold the byte array — a 4 byte `ay` taken from a 4 MB message keeps all
    4 MB alive. Only use it if you consume the value and drop it promptly.
  - `false` returns a plain array of numbers.
- ReturnLongjs - boolean (default:false): if true 64 bit dbus fields (x/t) are read out as Long.js objects, otherwise they are converted to numbers (which should be good up to 53 bits)
- ( TODO: add/document option to use address from X11 session )

connection has only one method, `message(msg)`

`message(msg)` returns `false` when the underlying socket's buffer is full,
following the same convention as [`stream.write()`](https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback).
A fast producer should stop writing when it sees `false` and resume on the
connection's `drain` event, otherwise messages queue in memory without bound:

```js
if (!connection.message(msg)) {
  await new Promise(resolve => connection.once('drain', resolve));
}
```

Messages written during the same tick of the event loop are batched into a
single write to the socket.

message fields:

- type - methodCall, methodReturn, error or signal
- path - object path
- interface
- destination
- sender
- member
- serial
- signature
- body
- errorName
- replySerial

connection signals:

- connect - emitted after successful authentication
- message
- drain - the socket's write buffer has emptied; safe to resume writing after
  `message()` returned `false`
- error - transport or protocol failure. A protocol error (a malformed or
  oversized message) is unrecoverable, so the connection is destroyed after it
  is emitted.
- handlerError - an exception thrown by one of your own `message`/signal
  listeners. It is reported separately from `error` because it is an
  application bug rather than a connection failure, and the connection stays
  usable. If nothing is listening for `handlerError` the exception is re-thrown
  asynchronously, matching Node's default behaviour for a throwing event
  listener.

example:

```js
const dbus = require('dbus-native');
const conn = dbus.createConnection();
conn.message({
  path: '/org/freedesktop/DBus',
  destination: 'org.freedesktop.DBus',
  interface: 'org.freedesktop.DBus',
  member: 'Hello',
  type: dbus.messageType.methodCall
});
conn.on('message', function (msg) {
  console.log(msg);
});
```

### Generating types for a service

`dbus-native types` introspects a live service and writes TypeScript
declarations for it. The generated file is types only — no runtime code, no
XML parsing at run time, and nothing to ship:

```shell
npx dbus-native types --system \
  --service org.freedesktop.NetworkManager \
  --path /org/freedesktop/NetworkManager \
  --out src/generated/network-manager.d.ts
```

```ts
import type { OrgFreedesktopNetworkManager } from './generated/network-manager';

const nm = await bus
  .getService('org.freedesktop.NetworkManager')
  .getInterface<OrgFreedesktopNetworkManager>(
    '/org/freedesktop/NetworkManager',
    'org.freedesktop.NetworkManager'
  );

const devices = await nm.GetDevices(); // string[], checked
```

Methods, properties and signals are all emitted, with argument names taken
from the introspection data where the service provides them.

| flag                  |                                                          |
| --------------------- | -------------------------------------------------------- |
| `--service`, `--path` | what to introspect                                       |
| `--system`            | use the system bus (default: session)                    |
| `--xml <file>`        | read saved introspection XML instead of a live bus       |
| `--out <file>`        | write to a file instead of stdout                        |
| `--target next`       | emit the 2.0 value shapes (`bigint`, plain objects)      |
| `--all`               | include the standard `org.freedesktop.DBus.*` interfaces |
| `--module <name>`     | module specifier for the type import                     |

`dbus-native introspect` prints the raw XML, which is handy for checking a
service's shape or for saving a fixture to generate from later.

The generated file records the service, path and target it came from, so
regenerating after upgrading is one command. Types generated with the default
`classic` target describe today's value shapes; see
[RELEASE_PLAN.md](./RELEASE_PLAN.md) for what changes in 2.0.

> **`dbus2js` is deprecated** (`DBUS_DEP0005`). It emits untyped ES5, generates
> no properties, and gives signals an over-broad match rule. It still works and
> prints the equivalent `dbus-native types` command when you run it, but it
> will be removed in a future major. See
> [docs/deprecations.md](./docs/deprecations.md#dbus_dep0005).

### TypeScript

Types ship with the package — no `@types/` install, and nothing to keep in
sync separately. They are checked in CI against a usage fixture, so they
cannot drift from the implementation without the build failing.

```ts
import dbus = require('dbus-native');
import { MessageBus, DBusInterface, TimeoutError } from 'dbus-native';

const bus: MessageBus = dbus.sessionBus({ timeout: 25000 });
const names: string[] = await bus.listNames();

// describe a remote interface for a checked surface
interface Player extends DBusInterface {
  PlayPause(): Promise<void>;
}
const player = await bus
  .getService('org.mpris.MediaPlayer2.vlc')
  .getInterface<Player>(
    '/org/mpris/MediaPlayer2',
    'org.mpris.MediaPlayer2.Player'
  );
await player.PlayPause();
```

Note that a call with no callback is typed as `DBusPromise<T>`, not
`Promise<T>` — see the note under [Promises](#promises) for why.

### Promises

Every callback-taking method returns a promise when you omit the callback. The
callback form is unchanged.

```js
const bus = dbus.sessionBus();

const iface = await bus
  .getService('org.freedesktop.Notifications')
  .getInterface(
    '/org/freedesktop/Notifications',
    'org.freedesktop.Notifications'
  );

const id = await iface.Notify('app', 0, '', 'summary', 'body', [], [], 5000);
const names = await bus.listNames();
```

Resolution follows the number of values in the reply: none resolves to
`undefined`, one resolves to the value, and several resolve to an array.

Rejections are always a `DBusError` with `message`, `dbusName`, `body` and
`reply`, plus the frames of the call site appended to the stack — a reply
arrives on the socket, so without that a failed call would only ever point at
this library's internals.

```js
try {
  await iface.Notify(/* ... */);
} catch (err) {
  if (err.dbusName === 'org.freedesktop.DBus.Error.ServiceUnknown') {
    // ...
  }
}
```

Two things worth knowing:

- Omitting the callback has always meant fire-and-forget, and a lot of code
  does `bus.invoke({ member: 'AddMatch', ... })` without one. So the returned
  value is a **thenable that only creates its promise when you `await` or
  `.then()` it** — ignore it and a failure is dropped exactly as it was before,
  rather than becoming an unhandled rejection that terminates the process. It
  is not an `instanceof Promise`, though it works with `await`, `Promise.all`
  and `.catch`/`.finally`.
- Capturing the call site costs about 1.95 µs against an 85.8 µs round trip
  (~2%), and only on the promise path.

### Observability

Traffic and call timing are published on
[`diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html), so
you can see what is happening without the library growing a logging API of its
own:

```js
const dc = require('node:diagnostics_channel');

// every message, in either direction
dc.subscribe('dbus:message:send', ({ message }) =>
  console.log('->', message.destination, message.member)
);
dc.subscribe('dbus:message:receive', ({ message }) =>
  console.log('<-', message.sender, message.member)
);

// method calls as a tracing channel: start / end / error share a context
const started = new WeakMap();
dc.subscribe('tracing:dbus:call:start', ctx => started.set(ctx, Date.now()));
dc.subscribe('tracing:dbus:call:end', ctx =>
  console.log(
    `${ctx.interface}.${ctx.member} took ${Date.now() - started.get(ctx)}ms`
  )
);
dc.subscribe('tracing:dbus:call:error', ctx =>
  console.error(`${ctx.member} failed:`, ctx.error.message)
);
```

Channels are checked for subscribers before any payload is built, so this costs
nothing when unused — measured at or below run-to-run noise against a ~45 µs
round trip, both unsubscribed and subscribed.

That makes a `dbus-monitor` equivalent, OpenTelemetry spans, or per-call timing
a few lines of application code rather than a library feature.

### Timeouts and cancellation

A call with no reply waits forever by default, which is the behaviour this
library has always had — and the reason a long-lived process can accumulate
pending calls that never resolve. Both a per-call and a per-client timeout are
available:

```js
// per call
await bus.invoke(msg, { timeout: 5000 });

// default for every call on this client
const bus = dbus.sessionBus({ timeout: 25000 });
```

A timeout rejects with a `TimeoutError` (`code: 'ETIMEDOUT'`,
`dbusName: 'org.freedesktop.DBus.Error.NoReply'`) **and removes the pending
call**, so nothing is left behind.

`AbortSignal` cancels a call, and composes with everything else that takes one:

```js
const ac = new AbortController();
process.on('SIGINT', () => ac.abort());
await bus.invoke(msg, { signal: ac.signal });

await bus.invoke(msg, { signal: AbortSignal.timeout(5000) });
```

Aborting rejects with an `AbortError` whose `cause` is the signal's reason. If
the signal is already aborted the message is never written to the socket.

Options work with callbacks too — `bus.invoke(msg, { timeout: 5000 }, cb)`.

The default stays "wait forever" in 0.x: making calls that currently hang start
failing is a behaviour change, and belongs in a major. See
[RELEASE_PLAN.md](./RELEASE_PLAN.md).

### Reading values: variants and dicts

A variant currently unmarshals as `[parsedSignature, [value]]` and a dict as an
array of `[key, value]` pairs. Both shapes change in 2.0 — see
[RELEASE_PLAN.md](./RELEASE_PLAN.md). Two helpers read either shape, so code
written against them behaves the same before and after:

```js
const { variantValue, toPlain } = require('dbus-native');

// instead of result[1][0]
const greeting = variantValue(result);

// instead of walking an array of pairs
const props = toPlain(getAllResult); // { Greeting: 'hello', Count: 7 }
```

`toPlain()` only converts arrays this library parsed as dicts, so an `a(ss)`
(array of two-string structs) is left as an array rather than being guessed at.

For writing, `Variant` is accepted anywhere a `[signature, value]` pair is:

```js
const { Variant } = require('dbus-native');

bus.invoke({
  /* ... */
  signature: 'ssv',
  body: [iface, 'Greeting', new Variant('s', 'hello')]
});
```

### Errors

A failed call passes a `DBusError` to the callback and rejects the promise with
one. It carries `message`, `dbusName`, `body` (the raw reply arguments) and
`reply`:

```js
bus.invoke(msg, err => {
  if (err?.dbusName === 'org.freedesktop.DBus.Error.ServiceUnknown') {
    // ...
  }
});
```

| class                   | when                                           | `code`        |
| ----------------------- | ---------------------------------------------- | ------------- |
| `DBusError`             | the call returned an error reply               | —             |
| `TimeoutError`          | no reply within the timeout                    | `ETIMEDOUT`   |
| `AbortError`            | cancelled through an `AbortSignal`             | `ABORT_ERR`   |
| `ConnectionClosedError` | the connection went away with the call pending | `ECONNCLOSED` |
| `UnknownInterfaceError` | the object does not implement that interface   | —             |

All of them extend `DBusError`, which extends `Error`.

Before 0.7 an error reply arrived as the raw message body — an array — and a
dropped connection left pending calls hanging forever. See
[docs/migrating-to-0.7.md](docs/migrating-to-0.7.md), and
[`dbus-native/compat`](docs/migrating-to-0.7.md#the-escape-hatch) if you need the
old shape while you migrate.

### Note on INT64 'x' and UINT64 't'

Long.js is used for 64 Bit support. https://github.com/dcodeIO/long.js
The following javascript types can be marshalled into 64 bit dbus fields:

- typeof 'number' up to 53bits
- typeof 'string' (consisting of decimal digits with no separators or '0x' prefixed hexadecimal) up to full 64bit range
- Long.js objects (or object with compatible properties)

By default 64 bit dbus fields are unmarshalled into a 'number' (with precision loss beyond 53 bits). Use {ReturnLongjs:true} option to return the actual Long.js object and preserve the entire 64 bits.

Development
-----------

```shell
npm test                 # lint, format check and unit tests
npm run test:integration # end-to-end tests against a real dbus-daemon
```

### Running a bus locally (including on macOS)

macOS has no D-Bus daemon running by default, and Linux desktops give you a
session bus you probably don't want tests writing to. Install the daemon
binary — nothing needs to run as a service:

```shell
brew install dbus          # macOS
sudo apt-get install dbus  # Debian/Ubuntu
```

Then start a private, throwaway session bus:

```shell
npm run dbus:session
```

It prints a `DBUS_SESSION_BUS_ADDRESS` you can export in another shell to point
the examples at it. `npm run test:integration` starts and stops one of these
automatically, so it never touches your real session bus. The integration tests
skip themselves when no bus address is set.

To exercise Linux-only services (BlueZ, NetworkManager, systemd), use a
container:

```shell
docker run --rm -it -v "$PWD":/app -w /app node:24 \
  sh -c 'apt-get update && apt-get install -y dbus && npm ci && npm run test:integration'
```

### Links

- http://cgit.freedesktop.org/dbus - freedesktop reference C library
- https://github.com/guelfey/go.dbus
- https://github.com/Shouqun/node-dbus - libdbus
- https://github.com/Motorola-Mobility/node-dbus - libdbus
- https://github.com/izaakschroeder/node-dbus - libdbus
- https://github.com/agnat/node_libdbus
- https://github.com/agnat/node_dbus - native js
- https://github.com/cocagne/txdbus - native python + twisted
- http://search.cpan.org/~danberr/Net-DBus-1.0.0/ (seems to be native, but requires libdbus?)
- https://github.com/mvidner/ruby-dbus (native, sync)
- http://www.ndesk.org/DBusSharp (C#/Mono)
- https://github.com/lizenn/erlang-dbus/ - erlang
- https://github.com/mspanc/dbux/ - elixir
- http://0pointer.net/blog/the-new-sd-bus-api-of-systemd.html - Blog post about sb-bus and D-Bus in general
