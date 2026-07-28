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

A failed call currently passes the raw message body — an array — to the
callback. Since 0.6 that array also carries `message`, `dbusName` and `name`,
which is the shape it becomes in 1.0:

```js
bus.invoke(msg, err => {
  if (err?.dbusName === 'org.freedesktop.DBus.Error.ServiceUnknown') {
    // ...
  }
});
```

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
