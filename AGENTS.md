# AGENTS.md

Orientation for coding agents working on `dbus-native`. Humans may find it
useful too.

## What this is

A pure-JavaScript implementation of the D-Bus protocol — wire format
(marshalling/unmarshalling), client, and a partial server. No native addons, no
build step, CommonJS. The reference for anything protocol-shaped is the
[D-Bus specification](https://dbus.freedesktop.org/doc/dbus-specification.html).

Runtime dependencies are deliberately minimal (`hexy`, `long`, `xml2js`). **Do
not add a runtime dependency without a strong reason** — several past releases
were spent removing them, and the small dependency tree is a feature users
choose this package for. `devDependencies` are less precious.

Node >= 20.8.0. That floor is load-bearing: it is the version that gained
native Linux abstract-socket support, which let us delete the `abstract-socket`
native addon.

## Layout

```
index.js              connection setup, address parsing, public entry point
lib/
  bus.js              MessageBus: invoke, signals, exportInterface, name mgmt
  message.js          message framing: marshall / unmarshalMessages
  marshall.js         signature-driven serialiser
  marshallers.js      per-type marshallers + range/type validation
  dbus-buffer.js      the deserialiser (DBusBuffer)
  signature.js        signature string -> tree
  writer.js           growable output buffer with a write cursor
  handshake.js        client SASL auth (EXTERNAL, DBUS_COOKIE_SHA1, ANONYMOUS)
  server-handshake.js server-side auth -- a STUB, see ROADMAP 4.5
  introspect.js       XML introspection -> proxy objects
  stdifaces.js        org.freedesktop.DBus.{Introspectable,Properties,Peer}
  constants.js        message types, header fields, endianness
bin/                  dbus-native (types/introspect CLI), dbus2js (legacy
                      codegen), dbus-dissect (traffic dumper)
lib/codegen/          introspection -> TypeScript declarations
scripts/              dev helpers for running a private session bus
test/                 unit tests (node:test)
test/utils/           test helpers and data, not test files
test/integration/     end-to-end tests against a real dbus-daemon
examples/             runnable examples; linted, so keep them valid
```

## Running things

```sh
npm test                  # lint + format check + unit tests
npm run test:raw          # unit tests only
npm run test:integration  # spins up a private dbus-daemon, runs test/integration
npm run lint:fix          # eslint --fix
npm run format            # prettier --write
```

### You need a bus for integration work

There is no D-Bus daemon running on macOS by default, and the library is
useless without one. Install the daemon once:

```sh
brew install dbus         # macOS
sudo apt-get install dbus # Debian/Ubuntu
```

Nothing needs to be running as a service. `scripts/dbus-daemon.js` starts a
**private, throwaway** session bus in a temp dir with a permissive config, so
tests never touch (or depend on) the user's real session bus.

- `npm run test:integration` wraps the test run in one automatically.
- `npm run dbus:session` starts one in the foreground and prints the
  `DBUS_SESSION_BUS_ADDRESS` export line, for poking at examples by hand.

The integration tests **skip themselves** when `DBUS_SESSION_BUS_ADDRESS` is
unset, so a bare `node --test` run stays green without a bus. If you add
integration tests, preserve that by passing the suite a `skip` option:

```js
const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

describe('integration: thing', { timeout: 10000, skip: NO_BUS }, () => {
  // ...
});
```

`skip` is evaluated when the file loads, so the whole suite — hooks included —
is skipped before anything tries to connect.

For Linux-only services (BlueZ, NetworkManager, systemd), use a container —
those interfaces cannot be exercised on macOS at all:

```sh
docker run --rm -it -v "$PWD":/app -w /app node:24 \
  sh -c 'apt-get update && apt-get install -y dbus && npm ci && npm run test:integration'
```

## Conventions

- CommonJS (`require`/`module.exports`). Do not convert to ESM piecemeal — that
  is a breaking change for every consumer and needs to be a deliberate major.
- Prettier owns formatting (single quotes, no trailing commas, arrow parens
  avoided). Never hand-format; run `npm run format`.
- ESLint enforces `no-var`, `prefer-const`, `prefer-arrow-callback`,
  `prefer-template`, `eqeqeq`. `console` is allowed (this is a protocol library
  with debug tooling).
- Callback style is `(err, result)` and is **public API**. Adding promise
  support means returning a promise when no callback is given — never replacing
  the callback path. See ROADMAP 3.1.
- Tests use the built-in **`node:test`** runner — no test framework dependency.
  Unlike mocha it exposes **no globals**, so every file imports what it uses:
  `const { describe, it, before } = require('node:test');`. ESLint has no
  test-globals block, so a forgotten import is a lint error rather than a
  runtime one. Per-test timeouts are an options object,
  `it('name', { timeout: 10000 }, fn)`, and a callback-style test takes the
  test context first: `it('name', (t, done) => …)`.
- Commits should be [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `deps:`, `docs:`, `chore:`). release-please derives the
  changelog and the version bump from them, so a mislabelled commit ships the
  wrong version.

## Landmines

These have each bitten someone before:

- **Alignment is the whole ballgame.** D-Bus pads every type to its natural
  boundary, and array lengths _exclude_ the padding that precedes the first
  element. `Writer.align()`, `marshall.js`'s `writeArray`, and
  `DBusBuffer.readArray` must agree. If a round-trip test fails on a compound
  type, suspect alignment first.
- **Alignment is relative to the message, not the buffer.** `Writer` takes a
  `base` offset because the header fields array is marshalled at offset 12
  within its message. A write method that pads using `pos` instead of
  `base + pos` will look correct in isolation and corrupt real messages.
- **`Writer` uses `Buffer.allocUnsafe`.** Any padding you add must be
  explicitly zero-filled, or uninitialised heap memory goes on the wire.
- **Variants unmarshal as `[signatureTree, [value]]`.** The value is at
  `[1][0]`. This leaks the parser's internal tree into the public API; it is
  ugly, widely depended on, and changing it is a breaking change (ROADMAP 4.1).
- **`ay` is special-cased to a Buffer** (`options.ayBuffer`, default true), so
  byte arrays do not round-trip as plain arrays.
- **64-bit types go through `long.js` and lose precision above 2^53** unless
  `ReturnLongjs` is set. Replacing this with BigInt is planned (ROADMAP 3.2).
- **`lib/server-handshake.js` is not a real implementation.** It replies with a
  hardcoded GUID and cookie and logs to stdout. Do not treat `createServer` as
  working infrastructure.
- **`lib/address-x11.js` requires `x11`, which is not a dependency.** Requiring
  that file throws unless the user installed it separately. It is intentionally
  opt-in.
- **`test/fixtures/` is excluded from Prettier.** Those bytes are test data;
  reformatting them breaks the tests.

## Before you finish

1. `npm test` passes (lint + format + unit).
2. `npm run test:integration` passes if you touched anything protocol-level,
   connection-level, or in `stdifaces.js`.
3. Examples still lint — they are part of the linted source set.
4. If you changed behaviour, check whether it closes an issue listed in
   `ROADMAP.md`, and update the roadmap.

## Where to look next

`ROADMAP.md` has the triaged backlog, including which open PRs are worth
reviving and the current state of the `dbus-next` / `@homebridge/dbus-native`
fork situation.

If you are touching the wire layer specifically, read **ROADMAP §2** first. It
is a measured audit of the marshaller, unmarshaller and stream framing, broken
into PR-sized blocks — including the known crash-on-malformed-input paths and
the ~2000× headroom on byte-array marshalling. Several of the landmines above
are scheduled to change there.
