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

Requires Node.js 22.12.0 or newer.

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

**[docs/api.md](docs/api.md) is the complete reference** — every entry point,
option, method, event, error class and diagnostics channel. What follows is
the tour.

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
- returnBigInt - boolean (default:true): 64 bit dbus fields (x/t) are read out as
  native `bigint`, which covers the whole range exactly. Set `false` for the classic
  behaviour, a `number` that loses precision above 2^53.

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

| flag                  |                                                           |
| --------------------- | --------------------------------------------------------- |
| `--service`, `--path` | what to introspect                                        |
| `--system`            | use the system bus (default: session)                     |
| `--xml <file>`        | read saved introspection XML instead of a live bus        |
| `--out <file>`        | write to a file instead of stdout                         |
| `--target classic`    | emit the classic value shapes (`number`, arrays of pairs) |
| `--all`               | include the standard `org.freedesktop.DBus.*` interfaces  |
| `--module <name>`     | module specifier for the type import                      |

`dbus-native introspect` prints the raw XML, which is handy for checking a
service's shape or for saving a fixture to generate from later.

The generated file records the service, path and target it came from, so
regenerating after upgrading is one command. The default `plain` target
describes the default value shapes; use `classic` for a connection reading with
`plainValues: false, returnBigInt: false`.

> **`dbus2js` was removed in 0.14.0** (`DBUS_DEP0005`), having warned since 0.6.
> It emitted untyped ES5, generated no properties, and gave signals an
> over-broad match rule. `dbus-native types` is the replacement — see
> [docs/deprecations.md](./docs/deprecations.md#dbus_dep0005) for the
> equivalent command.

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

### Signals

A proxy interface is an event emitter, and installs the match rule for you:

```js
iface.on('ActionInvoked', (id, action) => console.log(id, action));
iface.once('NotificationClosed', id => console.log('closed', id));
iface.off('ActionInvoked', handler); // drops the match rule with the last listener
```

Introspection records what the interface declares, so you can see what there is
to subscribe to — same `[signature, ...argumentNames]` shape a service is
exported with:

```js
iface.$signals; // { ActionInvoked: ['us', 'id', 'action_key'], ... }
```

Installing a match rule is a round trip, and `on` returns the interface for
chaining rather than something you can wait on. When you are about to trigger
the thing that emits the signal — or want to catch `AddMatch` being refused —
use `$subscribe`:

```js
await iface.$subscribe('ActionInvoked', handler); // resolved => the daemon is routing it
await iface.$unsubscribe('ActionInvoked', handler);
```

**PropertiesChanged** is a signal on `org.freedesktop.DBus.Properties`, not on
the interface owning the property, so subscribe to the standard interface:

```js
const props = await bus
  .getService(name)
  .getInterface(path, 'org.freedesktop.DBus.Properties');

await props.$subscribe('PropertiesChanged', (ifaceName, changed) => {
  for (const [prop, value] of changed) console.log(prop, variantValue(value));
});
```

For the service side of this, see
[docs/api.md](./docs/api.md#propertieschanged).

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

A variant unmarshals as the value it holds, and a string-keyed dict as a plain
object:

```js
const props = await iface.GetAll(name); // { Greeting: 'hello', Count: 7 }
const udi = await device.Udi(); // the value, not [tree, [value]]
```

| signature | default          | `plainValues: false`            |
| --------- | ---------------- | ------------------------------- |
| `v`       | `value`          | `[signatureTree, [value]]`      |
| `a{sv}`   | `{ key: value }` | array of pairs, values variants |

Reading only — writing takes plain objects and `Variant` — so a value read this
way can be written straight back out. A dict whose keys are not strings
(`a{us}`) stays as pairs, because a JavaScript object key is always a string
and converting one would change the key's type.

Both shapes changed in 0.14.0. Two helpers read either, so code written against
them behaves the same before and after:

```js
const { variantValue, toPlain } = require('dbus-native');

// instead of result[1][0]
const greeting = variantValue(result);

// instead of walking an array of pairs
const props = toPlain(getAllResult); // { Greeting: 'hello', Count: 7 }
```

`toPlain()` only converts arrays this library parsed as dicts, so an `a(ss)`
(array of two-string structs) is left as an array rather than being guessed at.
`dbus-native/compat` restores the classic shapes wholesale if you are not ready:

```js
const { withClassicTypes } = require('dbus-native/compat');
const bus = withClassicTypes(dbus.sessionBus());
```

To find the call sites in your own code that still read the old shapes:

```shell
npx dbus-native lint src/
```

```
src/net.js:42  DBUS_DEP0002  variant index chain `[1][1][0]`
    -> variantValue(), or a plain property read after 0.14.0
```

It reports rather than rewrites — an index chain says nothing about what the
value is, so there is no codemod for this that would not sometimes be wrong.
Exits non-zero when there are findings so it can gate CI; `--exit-zero` and
`--rule` adjust that.

For writing, `Variant` is accepted anywhere a `[signature, value]` pair is:

```js
const { Variant } = require('dbus-native');

bus.invoke({
  /* ... */
  signature: 'ssv',
  body: [iface, 'Greeting', new Variant('s', 'hello')]
});
```

### Writing dicts: just pass an object

Anywhere a dict is expected, a plain object will do — the most-asked question
about this library, and no longer a chore:

```js
await iface.SetOptions({ Name: 'widget', Count: 3, Enabled: true });
```

That writes exactly the same bytes as spelling every value out as a variant,
which still works and is unchanged. Inside an object, values are inferred:
strings to `s`, booleans to `b`, integers to `i` (or `x` when they do not fit),
other numbers to `d`, `Buffer` to `ay`, arrays to `a` + their element type, and
nested objects to `a{sv}`.

`Variant` overrides the guess, and reaches the types inference cannot produce:

```js
await iface.SetOptions({ Count: new Variant('u', 3) }); // uint32, not int32
```

Two things to know. **Inside an object an array is an array**, never a
`[signature, value]` pair — use `Variant` for an explicitly typed value. And
inference **refuses to guess** rather than picking something arbitrary: an
empty array, a mixed array like `[1, 'a']`, `null` and `NaN` all throw and say
what to do instead.

A variant read off the wire can also be written straight back, so a value can be
passed from one service to another without unwrapping it.

See [docs/api.md](docs/api.md#writing-a-dict-as-a-plain-object) for the full
table.

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
dropped connection left pending calls hanging forever. To update existing code:

```shell
npx dbus-native codemod errors-to-error-objects --dry src/
```

It rewrites the call sites it can attribute to a D-Bus call and reports the
rest rather than guessing. See
[docs/migrating-to-0.7.md](docs/migrating-to-0.7.md), and
[`dbus-native/compat`](docs/migrating-to-0.7.md#the-escape-hatch) if you need the
old shape while you migrate.

### The 0.14.0 value shapes

0.14.0 changed what values look like: a variant is the value it holds, a
string-keyed dict is a plain object, and `x`/`t` are `bigint`.

Code written against `variantValue()` and `toPlain()` needed no change at all —
they read either shape. `npx dbus-native lint src/` finds the rest.
[docs/migrating-to-2.0.md](docs/migrating-to-2.0.md) is the guide, and leads
with `bigint`, which is the part that breaks code far away from the call.

**Each old shape is still an option**, per connection, so a program can move
back a subsystem at a time rather than in one step:

```js
const bus = dbus.sessionBus({ plainValues: false, returnBigInt: false });
```

or all at once, with `withClassicTypes` from `dbus-native/compat`.

### Names

Object paths, interface names, error names and member names each have their own
rules, and a name that breaks them produces a message no peer can route. Those
you **send** are now checked — `exportInterface` (the path, the interface name
and every member name), `sendSignal`, `sendError`, and any `o` value, which
covers the path header of every outgoing message. Property names get a looser
rule of their own, since the specification gives them none: a member name that
may also contain `-`. Each throws an `Error` naming the rule that was broken:

```
Invalid interface name for the interface descriptor: "MyIface" -- must be two or
more dot-separated elements of [A-Za-z_][A-Za-z0-9_]*, at most 255 bytes
```

This matters most for signals: a method call with a bad name comes back as an
error from the daemon or the peer, but a signal gets no reply and simply
vanishes.

Names that arrive from a peer are not checked — strict in what you send,
lenient in what you accept. For names built at runtime, the predicates are
exported so you can check rather than catch:

```js
const { isValidObjectPath } = require('dbus-native');
isValidObjectPath(`/com/example/${deviceId}`); // a '-' in deviceId would throw at export
```

See [docs/api.md](docs/api.md#names) for the full rules.

### 64-bit values: INT64 'x' and UINT64 't'

These are unmarshalled into a native `bigint`, which covers the whole range
exactly:

```js
const size = await disk.Size(); // 2000398934016n
```

Before 0.14.0 they were a `number`, which **loses precision above 2⁵³** —
`9223372036854775807` came back as `9223372036854776000`. `returnBigInt: false`
restores that, per connection, so services and clients can be moved one at a
time — though note a service reads its _arguments_ through the same parser, so
setting it there affects large 64-bit inputs too.

`bigint` is not a drop-in for `number`, and the failure mode is a `TypeError`
in production rather than a subtly wrong value. Plan for it:

```js
size + 1; // TypeError: Cannot mix BigInt and other types
JSON.stringify({ size }); // TypeError: Do not know how to serialize a BigInt
size > 100; // fine, comparisons work
Number(size); // fine, if you accept the precision loss you already had
```

These can be **written** to a 64-bit field, whatever the read option:

- `bigint`, over the full range
- `number`, up to 53 bits
- `string`, decimal or `0x`-prefixed hex, over the full range
- Long.js objects, or anything with compatible `low`/`high`/`unsigned`

`ReturnLongjs` was removed in 0.14.0 and now throws, rather than quietly handing
back a type it was not asked for; `returnBigInt: false` is the way to a
`number`. [Long.js](https://github.com/dcodeIO/long.js) is no longer a
dependency at all, which also removes the ARMv6 crash that made downstream
forks vendor their own copy — a Long is still _accepted_ on the way in, since
the check is on its `{low, high, unsigned}` shape and costs no import.

### File descriptors (`h` / UNIX_FD)

A descriptor does not travel inside a message — it rides beside it as ancillary
data, and `h` is a uint32 index into what arrived. Node has no API for that, so
on Node a message carrying one is refused with an error that says why.

**Under Bun it just works.** A unix connection there is one this package drives
itself with `sendmsg`/`recvmsg` through `bun:ffi` — still no dependency, no
compiler, no build step:

```js
const bus = dbus.sessionBus(); // under Bun
bus.connection.canPassFds; // true

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

That is what makes systemd's `DumpByFileDescriptor`, the XDG portals'
`OpenPipeWireRemote`, logind's `Inhibit` and `TakeDevice`, UDisks2's
`LoopSetup` and BlueZ's `Acquire` reachable at all. See
[docs/api.md](docs/api.md#file-descriptors) for the details, including how to
supply your own transport on Node.

Development
-----------

```shell
npm test                 # lint, format check and unit tests
npm run test:integration # end-to-end tests against a real dbus-daemon
npm run test:bun         # the Bun-only fd transport (needs bun)
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

If you run a system-wide bus on macOS instead (`brew services start dbus`),
`sessionBus()` finds it without any environment variable: macOS advertises the
session bus through launchd rather than `DBUS_SESSION_BUS_ADDRESS`, and that is
now the fallback. `launchd:env=…` addresses work anywhere a `busAddress` does.

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
