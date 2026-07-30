# AGENTS.md

Orientation for coding agents working on `dbus-native`. Humans may find it
useful too.

## What this is

A pure-JavaScript implementation of the D-Bus protocol — wire format
(marshalling/unmarshalling), client, and a partial server. No native addons, no
build step, CommonJS. The reference for anything protocol-shaped is the
[D-Bus specification](https://dbus.freedesktop.org/doc/dbus-specification.html).

Runtime dependencies are deliberately minimal (`long`, `xml2js`). **Do
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
  server-handshake.js server-side SASL auth, the same three mechanisms
  broker.js           an in-process message bus: org.freedesktop.DBus, routing
  match-rule.js       match rule parsing and evaluation
  introspect.js       XML introspection -> proxy objects
  stdifaces.js        org.freedesktop.DBus.{Introspectable,Properties,Peer}
  constants.js        message types, header fields, endianness
bin/                  dbus-native (call/get/set/list/types/introspect/codemod/
                      lint), dbus2js (legacy codegen), dbus-dissect (dumper)
lib/cli/              the dbus-send shaped subcommands
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
- `npm run test:integration:broker` runs the same suite against
  `lib/broker.js` instead, which needs nothing installed. Running it both ways
  is how a disagreement between the two buses gets noticed.
- `npm run dbus:session` starts one in the foreground and prints the
  `DBUS_SESSION_BUS_ADDRESS` export line, for poking at examples by hand.

### The 2.0 shape gate

```sh
npm run test:integration:2.0               # against dbus-daemon
npm run test:integration:2.0:broker        # against lib/broker.js
npm run test:integration:2.0-wrap          # variants: 'wrap' as well
npm run test:integration:2.0-wrap:broker
```

Same suite, run with the value shapes 2.0 makes the default: a variant reads as
its value, a string-keyed `a{sv}` as a plain object, and `x`/`t` as `bigint`.
`DBUS_TEST_SHAPE` turns them on through `test/utils/shape.js`, which every
integration file gets its connections from. It takes `classic` (the default),
`2.0`, or `2.0-wrap` — the last being the same shapes but with variants read as
`Variant` instances, which is what a caller opts into when it needs the type
back. All three must pass.

**This is the gate for the major.** Flipping those defaults is the largest
break in RELEASE_PLAN, and until this passed there was no way to find out what
it costs except by shipping it. Both runs are green today, which is the useful
fact: the library already works in the flipped shape, so what remains is
migration support rather than repair.

Two rules keep it meaningful:

- **A test asserts behaviour, not a shape.** Read values with `variantValue()`
  and `toPlain()` from `lib/values.js` — the accessors we tell users to migrate
  to, which are the identity in the new shape. Any test that reads `[1][0]` or
  maps over dict pairs passes in exactly one of the two runs.
- **A test that _is_ about a shape says so in its options.** `sessionBus()`
  layers caller options over the defaults, so `{ returnBigInt: false }` keeps
  meaning that after the flip. `PLAIN_VALUES` and `RETURN_BIGINT` are exported
  for the handful of assertions that genuinely cannot be written both ways.

`test/integration/shape.js` asserts that the requested shape is the shape a
real connection delivers, because `DBUS_TEST_SHAPE` travels through two
`npm run` hops and a wrapper process to get there. A broken chain would turn
the whole gate green while testing nothing, which is worse than red.

**The integration suite used to run one file at a time**, because roughly one
concurrent run in five failed — a different test each time, always a service
answering `UnknownMethod` for something it had definitely exported. It runs in
parallel again, and is about 3× faster for it (9.3s → 3.1s).

The cause was a **bug in this library, not in the tests**: dispatch never
looked at `msg.destination`. A match rule with no `type=` — `''`, or
`eavesdrop='true'` — makes the daemon deliver every message on the bus to that
connection, method calls included. The connection answered each one as if it
were its own, found nothing exported, and replied `UnknownMethod` **to the
original sender, carrying the original serial** — settling a call the victim
was waiting on with a failure from a process it had never spoken to, in a
different test file.

`test/integration/match-rules.js` asks the daemon which rules it accepts, and
both of those are in its corpus, so the suite was generating the traffic that
broke itself. `lib/bus.js` now ignores what is not addressed to it, checked
before `stdifaces` so an eavesdropper does not answer `Introspect` for other
people's objects either. See `test/integration/eavesdropping.js`, which fails
three ways without the fix.

Two things worth keeping in mind when touching dispatch:

- A connection knows which well-known names it owns from `bus.names`, kept
  current by the `NameAcquired`/`NameLost` signals the daemon sends unprompted.
  The reply to `RequestName` is deliberately _not_ consulted — it would be
  redundant, since the signal is emitted while the daemon handles RequestName,
  before any other client can learn the name has an owner.
- `--test-concurrency=8` in a loop is still the way to shake out anything like
  this. It reproduced at 3/10 before and 0/15 after.

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
- **64-bit types lose precision above 2^53** unless `returnBigInt` is set.
  BigInt becomes the default in 2.0 (RELEASE_PLAN).
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
