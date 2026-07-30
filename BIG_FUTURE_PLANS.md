# BIG_FUTURE_PLANS.md

What `dbus-native` would look like if it were designed today, with backwards
compatibility off the table.

**Revised 2026-07-30, at v0.12.0.** The first draft was written 2026-07-28,
before 0.6 through 0.12 shipped. Roughly half of it is now in the package, so a
straight re-read would be misleading. This revision does three things: records
what landed, records **where building it proved the design wrong**, and states
what perfect DX looks like from here.

The corrections in §2 are the point of this document. They are not second
thoughts — each one is something that only became visible by shipping the thing
next to it.

Everything marked ✅ has code and tests. Everything else is a proposal.
Feature availability was re-checked on Node 26 (§4), not assumed.

---

## 0. Where the sketch was right

The original §0 listed what was wrong with the library. Most of it is fixed.

| the complaint                      | then                           | now                                                           |
| ---------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| errors are not `Error`s            | `err` is an array of strings   | ✅ `DBusError` with `dbusName`, `body`, a real stack (0.7)    |
| everything is a callback           | #9 open since 2013             | ✅ promises everywhere, callbacks still supported             |
| no timeouts, no cancellation       | `bus.cookies` leaked forever   | ✅ `timeout`, `AbortSignal`, entries removed on settle        |
| no types                           | #276                           | ✅ hand-written `index.d.ts` + `dbus-native types` codegen    |
| reading a value walks a parse tree | `dict.find(…)[1][1][0]`        | ✅ the value itself, by default; `variantValue()`/`toPlain()` |
| 64-bit is lossy                    | `number`, or a long.js object  | ✅ `bigint`, by default                                       |
| nothing is inspectable             | "I sent something and it hung" | ✅ `diagnostics_channel`, `dbus-dissect`, `dbus-native call`  |
| tests need a system daemon         | `brew install dbus`            | ✅ `createBroker()` — in-process bus, 161 tests run on it     |
| the server side is a stub          | hardcoded 2014 GUID            | ✅ real SASL, three mechanisms, match rules, routing          |
| properties are all `readwrite`     | #89                            | ✅ `access` declared, enforced, and in the introspection XML  |
| a bad name produced a dead message | #309                           | ✅ validated on export and send                               |

What is left from the original sketch: **`await using` (§1), proxies (§2), the
value-shape flag day (§3), async-iterable signals (§5), `defineInterface` (§7),
and ESM (§9).** That is the breaking window, and it is the subject of the rest
of this document. Everything in it has now shipped except ESM.

The single most important thing the sketch got right, and it is worth
restating because it constrains everything below: **the wire layer is good and
must not be rewritten.** Marshalling, parsing and framing were measured and
hardened across 0.5–0.12. All of the work here is above them.

---

## 1. The shape of a program

Before the corrections, here is the target, so the corrections have something
to attach to.

```js
import { sessionBus, Variant } from 'dbus-native';

await using bus = await sessionBus();

const notifications = await bus.proxy(
  'org.freedesktop.Notifications',
  '/org/freedesktop/Notifications'
);

const id = await notifications.Notify(
  'example',
  0,
  '',
  'summary',
  'body',
  ['default', 'Open'],
  { urgency: new Variant('y', 1) },
  5_000
);

using sub = notifications.on('NotificationClosed', ([closed, reason]) => {
  if (closed === id) console.log('closed:', reason);
});
```

Every resource in that snippet is released by the language rather than by
discipline. That is the whole thesis.

---

## 2. What building it proved wrong

### 2.1 The parse tree was never the right "typed" shape — `Variant` is ✅

The original §3 said a variant reads as "the value, or `Variant` when asked".
Shipping `plainValues` showed **there is no way to ask**, and that this is not
a small omission: two real consumers hit it inside a week.

- `dbus-native call` prints `variant u 501`. That `u` exists only in the parse
  tree, so the CLI had to pin `plainValues: false` to keep printing types.
- A service receiving `a{sv}` cannot discover what types its caller sent. The
  integration test for it has a branch that asserts `undefined` and explains
  why, which is the shape of a gap, not a test.

The fix is not a third read mode. It is noticing that **the parse tree was
always the wrong carrier** — it leaked the parser's internals, it is unreadable
in a debugger, and it cannot be sent back. `Variant` already exists, already
carries `signature` and `value`, already has a custom `inspect`, and the
marshaller already accepts it on the write path.

So 2.0 has **two** read shapes, not three:

```js
// default: the value
const level = await dev.props.Percentage; // 87

// opt in per connection, or per call where it matters
const bus = await sessionBus({ variants: 'wrap' });
const v = await dev.props.Percentage; // Variant('d', 87)
v.signature; // 'd'
v.value; // 87
variantValue(v); // 87 -- the accessor already handles it
```

`variants: 'wrap'` is strictly better than the classic tree at the one job the
tree had, and it round-trips: a value read in `wrap` mode can be sent straight
back out. The tree survives only inside `withClassicTypes`, which is where a
legacy shape belongs.

**This is the highest-value correction in this document.** It turns a known gap
into a better API than the one being replaced.

**Shipped.** `variants: 'tree' | 'plain' | 'wrap'`, defaulting to whatever
`plainValues` implied so it is purely additive. The whole integration suite runs
under it (`npm run test:integration:wrap`) and found **no place in the
library that indexes into a variant** — only the tests written to assert a
specific shape, plus one real bug: `withClassicTypes` had to pin
`variants: 'tree'` as well, or a caller who opted into `'wrap'` kept their
Variants through it.

`dbus-native call` is the proof it earns its keep. It used to pin
`plainValues: false` purely to keep printing `variant u 501`; it now runs on the
full 2.0 shapes with `variants: 'wrap'` and prints byte-identical output.

### 2.2 `ay` stays a `Buffer` — the two documents disagreed

The original §3 table said `ay` → `Uint8Array` on web-standards grounds.
`RELEASE_PLAN.md` §2.0 later argued the opposite and is right: `Buffer` **is** a
`Uint8Array` subclass, so every consumer of the latter already accepts the
former, while `buf.toString('utf8')` — used constantly — does not exist on a
plain `Uint8Array`. Breaking it costs real code and buys nothing in a Node-only
library.

The table in this document is now corrected. `ay` is a `Buffer`, unchanged.

### 2.3 A member-name proxy hangs on `await` unless `then` is guarded

The original §2 described a `get` trap that resolves any member name. Awaiting
such a proxy — directly, or by returning one from an `async` function — makes
`await` look up `.then`, find a function, call it with `(resolve, reject)`, and
wait forever. Demonstrated, not theorised:

```js
const naive = new Proxy(
  {},
  {
    get:
      (t, k) =>
      (...a) =>
        `called ${String(k)}`
  }
);
await naive; // hangs. Permanently.
```

Any proxy design must return `undefined` for `then`, and should also pass
through `Symbol.toStringTag`, `util.inspect.custom`, `constructor` and
`Symbol.iterator` rather than manufacturing methods for them. This is a
one-line fix and a multi-hour debugging session for whoever hits it, which is
exactly the kind of thing a design document should carry.

Two consequences for the design:

- `bus.proxy()` returns a **promise of** a proxy, and the proxy itself is never
  a thenable. Introspection happens in `proxy()`, not lazily in the trap.
- The `$`-prefixed members (`props.$all`, `props.$set`) are worth keeping, and
  for a better reason than the original gave: a D-Bus member name matches
  `[A-Za-z_][A-Za-z0-9_]*`, so `$` is a **guaranteed-collision-free** namespace
  rather than merely an unlikely one.

### 2.4 Signals: the callback form is primary, not the iterable ✅

The original §5 led with `for await`. That emphasis is wrong, for two reasons
that only became clear with the async-iterator-helper check.

**Async iterator helpers are still not in Node** (re-verified on 26 — §4). So
`.map()`, `.filter()`, `.take()` do not exist on these streams, which removes
most of what made the iterable form attractive. Composing by hand with an async
generator works, but that is a worse API than a callback.

**More fundamentally, an async iterator is a queue and a signal is a
broadcast.** If the consumer is slower than the bus, something has to give, and
the original buried that decision in a `queueing` option. Perfect DX does not
make silent unbounded buffering reachable at all:

```js
// primary: a callback, with a subscription the language releases
using sub = nm.on('StateChanged', ([state]) => {
  /* ... */
});

// convenience: iteration, when you genuinely want to consume in sequence
for await (const [state] of nm.signal('StateChanged', { queue: 64 })) {
  if (state === CONNECTED) break; // removes the match rule
}
```

`queue` is required to be a bound or the literal `'latest'`. There is no
unbounded option, because a long-lived daemon with an unbounded signal queue is
a memory leak with a countdown, and this library's users skew toward long-lived
daemons.

**Shipped** as `proxy.$watch()` and `proxy.$signal()`. Two details the sketch
did not settle: overflow drops the _oldest_, because a consumer catching up
wants current state rather than what it already missed, and the count is on
`iterator.dropped` so it is not silent. `$watch` earns its place separately
from `$on` by resolving once the match rule is actually in place — `$on` cannot
report that, so a signal emitted immediately after subscribing was a coin flip.

The queue policy is `lib/signal-stream.js`, which is pure logic and unit-tested
without a bus; only "the rule really goes on and comes off" needs a daemon.

### 2.5 The value-shape gate is the precondition ✅

Not a correction so much as a change in what was possible. The whole suite runs
under each of the three value shapes, against both `dbus-daemon` and the
in-process broker — six runs. Before it existed the flag day was unverifiable;
the measurement that motivated it found 9 failures, **all of them in tests
asserting old shapes rather than in the library**.

**The flip has since happened, and the gate was worth more than that suggests.**
Two things it caught that the `2.0` run alone would not have:

- The `wrap` run found a real routing bug. `lib/broker.js` read variants
  flattened and re-marshalled them, so `Variant('u', 9)` was delivered to the
  next hop as `i` — a type its sender never wrote. The lesson generalises: a
  router must opt out of _every_ convenience shape, because each one discards
  something (the signature, duplicate dict keys, the low bits of a 64-bit
  integer) that the next hop was entitled to.
- Keeping `classic` as a run of its own is what makes `withClassicTypes` a
  supported escape hatch rather than a claim. An escape hatch nothing exercises
  stops working quietly.

The unit suite has no such gate, and that showed: several files read a shape
through the _default_ rather than naming it, so the flip would have turned them
into assertions that pass trivially. Naming both shapes explicitly is the fix,
and is now the rule in AGENTS.md.

---

## 3. What the sketch missed entirely

### 3.1 `ObjectManager` — the biggest real-world gap

Not mentioned anywhere in the original document, and it is how you enumerate
anything on a modern bus. BlueZ, NetworkManager, systemd and UDisks all expose
their object trees through `org.freedesktop.DBus.ObjectManager`. Today the
library has a `// TODO: emit ObjectManager's InterfaceAdded` in `lib/bus.js` and
no client-side support at all, so "list the Bluetooth devices" — the single most
common thing anyone wants — means hand-decoding `a{oa{sa{sv}}}`.

Both halves are needed.

**Consuming:**

```js
const bluez = await bus.objects('org.bluez', '/');

const devices = bluez.filter('org.bluez.Device1'); // { path: { iface: props } }

using sub = bluez.on('added', (path, interfaces) => {
  /* ... */
});
using gone = bluez.on('removed', (path, interfaces) => {
  /* ... */
});
```

`bus.objects()` calls `GetManagedObjects` once, subscribes to
`InterfacesAdded`/`InterfacesRemoved`, and keeps a live view. That is the thing
people write by hand today, badly, and it composes with §2.1: the properties
arrive as plain objects.

**Exporting:** a service that exports objects under a path should be able to
answer `GetManagedObjects` and emit the signals without writing any of it:

```js
await using tree = await bus.exportTree('/com/example');
await tree.add('/com/example/Thing1', thing); // InterfacesAdded emitted
```

This closes a whole category of tracker questions and is, in my judgement, worth
more per line than proxies.

### 3.2 Reconnection ✅

A daemon that loses the bus currently has no story at all. For an audience that
skews toward Raspberry Pi and Homebridge — where ~41k weekly downloads sit on a
fork of this package — that is a real gap. It does not have to be automatic, but
it has to be _possible_ and documented:

```js
const bus = await sessionBus({
  reconnect: { retries: Infinity, backoff: 'exponential' }
});
bus.on('reconnected', () => {
  /* names re-requested, match rules re-added */
});
```

The hard part is not the socket, it is that a reconnect invalidates the unique
name, every match rule and every owned name. Whatever ships must re-establish
those or say loudly that it does not.

**Shipped**, opt-in, and it does re-establish all three -- before `reconnected`
fires, so a service is reachable by the time anyone hears about it. What it
does _not_ do is retry calls that were in flight: they were already failed when
the socket went, and a method call is not idempotent. Re-issuing is the
caller's decision, which is what the event is for.

Building it turned up two bugs that had nothing to do with reconnection and
everything to do with nothing ever having reconnected before: `lib/broker.js`
removed the parent directory of its socket on close whether or not it had
created it, and `bus.names` held the unique name alongside the well-known ones
-- harmless until something tried to re-request them.

### 3.3 The file-descriptor transport seam — the one breaking thing that must land now

`ROADMAP.md` §2.8 scoped UNIX_FD on 2026-07-29 and concluded that the feature is
**not buildable today** (no Node ancillary-data API; the one viable addon needs
a compiler on every install) but is **additive when it becomes possible**.

The part that matters here: carrying descriptors means a message is
`{ bytes, fds }` rather than a `Buffer`, in both directions. That touches
`connection.message()`, the cork/uncork write batching, `unmarshalMessages()`,
and `opts.stream` — the seam a caller supplies their own transport through.

**So the feature is a minor, but the seam is a major.** If the breaking window
closes without it, UNIX_FD costs another major later. Defining
`stream.writeWithFds?` / `stream.on('fds')` as an optional capability now, with
nothing behind it, is cheap insurance and belongs in this release train.

**Shipped, and it turned out to be more than a seam.** Once the message is
`{ bytes, fds }` and `h` is the uint32 index the spec always said it was, the
only missing piece is the stream — so the whole protocol is implemented and
tested against a mock transport, and UNIX_FD works today for anyone who supplies
one. The package still depends on nothing. That is a better outcome than the
placeholder this section asked for, and it came from noticing that "not
buildable" was about the _transport_, never about the protocol.

---

## 4. The platform moved — re-checked on Node 26

Two of these change decisions the original made.

| feature                                | status on Node 26         | consequence                               |
| -------------------------------------- | ------------------------- | ----------------------------------------- |
| `Symbol.asyncDispose`                  | ✅ from Node **20**       | §1 works across the whole supported range |
| `await using` keyword                  | ✅ from Node **24**       | consumer's choice; unusable in our tests  |
| `AsyncDisposableStack`                 | ✅ from Node **24**       | §1, feature-detected                      |
| `Promise.withResolvers()`              | ✅ native                 | simplifies the cookie table               |
| `AbortSignal.timeout()`, `Error.cause` | ✅ native                 | shipped already                           |
| **`require()` of an ESM module**       | ✅ **unflagged** (22.12+) | **weakens the ESM-only objection**        |
| **TypeScript type stripping**          | ✅ **unflagged**          | changes the codegen story, not decorators |
| Sync iterator helpers                  | ✅ native                 | —                                         |
| **Async iterator helpers**             | ❌ still absent           | §2.4 — callbacks lead                     |
| **Decorators**                         | ❌ still a `SyntaxError`  | §7 stays `defineInterface`                |

**`require(esm)` is the significant one.** The original argued for ESM-only on
the grounds that a dual package ships two copies of `Variant` and breaks
`instanceof`. That argument still holds. But the _cost_ of ESM-only has dropped
sharply: a CJS consumer can now `require()` an ESM `dbus-native` directly —
**provided the entry point has no top-level await**, which otherwise fails with
`ERR_REQUIRE_ASYNC_MODULE`. Verified both ways.

That makes ESM-only tractable much earlier than the original assumed, and turns
"no top-level await in any entry point" into a hard architectural rule worth
writing down now.

**Type stripping does not help decorators** — verified: a decorator is still a
`SyntaxError` under it, because decorators are a runtime feature and not an
erasable type. The original's conclusion stands unchanged: `defineInterface` is
the API, decorators are an optional export for people who already have a
TypeScript pipeline.

**Node 20 reached end of life on 2026-04-30.** The current floor of 20.8.0 is
now a dead LTS line. A major is the moment to raise it; Node 22 is the
conservative choice and 24 buys `await using` in our own source. I would raise
to 22 and use `Symbol.asyncDispose` without the syntax internally, because the
embedded audience upgrades slowly and the syntax is a convenience for us, not a
capability.

---

## 5. Revised type mapping

Superseding the original §3 table, with §2.1 and §2.2 folded in.

| D-Bus               | 1.x                                 | 2.0                                                  |
| ------------------- | ----------------------------------- | ---------------------------------------------------- |
| `s` `o` `g`         | string                              | string                                               |
| `y` `n` `q` `i` `u` | number                              | number                                               |
| `x` `t`             | lossy `number`, or a long.js object | **`bigint`**                                         |
| `d`                 | number                              | number                                               |
| `b`                 | boolean                             | boolean                                              |
| `ay`                | `Buffer`                            | **`Buffer`** — corrected, see §2.2                   |
| `a{sv}` `a{ss}`     | array of `[key, [tree, [value]]]`   | plain object                                         |
| `a{iv}` etc.        | array of pairs                      | array of pairs — a key must be a string              |
| `as`                | array                               | array                                                |
| `(...)`             | array                               | array (tuple)                                        |
| `v`                 | `[tree, [value]]`                   | the value, or **`Variant`** under `variants: 'wrap'` |
| `h`                 | throws                              | throws, with the seam defined — §3.3                 |

---

## 6. What is actually breaking, and what is not

The useful cut, now that the gate exists to verify it.

**Breaking, needs the major:**

- ~~the value shapes becoming the default (§5)~~ ✅ **done.** Every failure it
  produced was a test asserting a shape rather than a defect — except one,
  which only the gate's `wrap` run caught: `lib/broker.js` read variants
  flattened and re-marshalled them, so a routed `Variant('u', 9)` was delivered
  as `i`. A router has to opt out of _every_ convenience shape, not just the
  lossy 64-bit one it already knew about. The flip also made the plain shape
  unwritable at a bare `v` until `write()` learned to infer there, exactly as
  it already did inside `a{sv}`.
- the `{ bytes, fds }` message seam (§3.3) — the feature is additive, the seam
  is not
- ESM-only, with the no-top-level-await rule (§4)
- the Node floor (§4)
- ~~dropping `long`, `ReturnLongjs`, `dbus2js`, and `lib/address-x11.js` — which
  is published in `lib/` and throws `Cannot find module 'x11'` on require~~ ✅
  **done.** Runtime dependencies are down to **one**, `xml2js`. `long` became a
  devDependency rather than disappearing: the marshaller still accepts a Long
  on input, recognised structurally by `{low, high, unsigned}` so it costs no
  import, and the tests need the real package to build one. `ReturnLongjs`
  throws rather than being ignored, because code that sets it expects a Long
  and would otherwise meet `value.toNumber is not a function` somewhere else
  entirely.
- ~~`defineInterface` replacing the positional descriptor arrays~~ — shipped
  **additively** instead, which turned out to be the whole of it: it compiles
  to the classic descriptor, so `exportInterface` is unchanged and nothing
  downstream knows which spelling was used. Nothing had to break. The handler
  context (#230) came for free, because `bus.js` already passed the message
  after the arguments — what was missing was a shape around it rather than the
  data.

**Additive, ships whenever it is ready:**

- ~~`await using` / `Symbol.asyncDispose`~~ ✅ shipped. `bus.close()`,
  `bus.watch()` and `bus.ownName()`, each disposable. Measured while building
  it: `Symbol.asyncDispose` is available from Node 20 but `AsyncDisposableStack`
  and the `using` keyword only from 24 — so the protocol works on the whole
  supported range and the keyword stays the consumer's choice, exactly as this
  document argued. The keyword cannot appear in our own tests at all: it is a
  syntax error on 20 and 22, which fails the file before a skip could run.
- `bus.proxy()` — a new method beside `getService()`
- `bus.objects()` and `exportTree()` (§3.1)
- signal subscriptions and the iterable form (§2.4)
- `variants: 'wrap'` (§2.1) — an option today, meaningful after the flip
- reconnection (§3.2)
- UNIX_FD itself, once a transport exists

That split is more favourable than the original assumed, and it suggests the
order: **land the additive ergonomics first, on 0.x, where they can be used and
corrected by real consumers — then flip the defaults once.** The flag day should
be the last thing that happens, not the first, and by then the gate will have
been green for months.

---

## 7. What I would still cut

Unchanged from the original, and re-confirmed:

- **The `dbus:` import specifier and the XML loader.** Fashionable, fragile,
  breaks bundlers, costs a loader registration in every consumer. Native type
  stripping makes the codegen path _better_, which weakens the case further.
- **Decorators as the primary service API.** Still not native.
- **Auto-inferring signatures from plain JS where no introspected signature is
  available.** `{ a: 1 }` could be `a{sy}`, `a{si}`, `a{su}`, `a{sd}` or
  `a{sv}`. Infer only where the signature is known; require `Variant` otherwise.

And one addition:

- **A third variant read mode.** §2.1 replaces the parse tree rather than
  joining it. If `variants: 'wrap'` cannot do a job, that is a bug in `Variant`,
  not an argument for exposing the parser's internals again.

And one thing worth doing _before_ any of it:

- **Answer [#263](https://github.com/sidorares/dbus-native/issues/263).** It
  asks whether this package should be deprecated in favour of `dbus-next`. Every
  proposal here is an argument that the answer is no, and none of them are worth
  building if the answer is yes. It is the cheapest issue on the list to close
  and the one that changes the most.

---

## 8. Risks

Mostly unchanged, with one downgraded and one added.

- **This is an API rewrite, not a refactor** — but less of one than it was. Half
  the sketch shipped without breaking anyone, which is evidence the incremental
  path works better than expected. _Downgraded._
- **Two live surfaces is how `dbus-next` and this package both ended up
  half-maintained.** Whatever ships must be this package. Still the top risk.
- **9.3k weekly downloads on the current API**, plus 37k on the Homebridge
  fork that tracks it closely (npm, week ending 2026-07-28). The
  migration tooling now exists — lint rule, codemod, `withClassicTypes`,
  `docs/migrating-to-2.0.md` — which is the difference between a break and a
  fork.
- ~~**The integration flake is mitigated, not explained.**~~ **Root-caused and
  fixed.** It was a real dispatch bug, and the instinct to chase it before
  building more on top was right: a connection answered method calls it was
  merely _overhearing_, because dispatch never checked `msg.destination`. A
  match rule with no `type=` makes the daemon deliver everything, and the
  eavesdropper's `UnknownMethod` reply carried the real sender's serial —
  settling somebody else's call, in another process, with an error. The suite's
  own `match-rules.js` corpus generates exactly that traffic.

  The suite runs in parallel again and is 3× faster. Worth noting what it says
  about the earlier evidence: "a connection with an empty `exportedObjects`
  receiving a call for a name it does not own" was reported as impossible under
  unicast routing, and it _was_ — the message was never unicast to it.

---

## Appendix: the tracker, checked

The original closed with "over half the open tracker", which was true when it
was written and is now the wrong argument entirely — **the tracker is down to 11
open issues.** Checked 2026-07-30, because inheriting a stale list is how a
design document starts justifying itself with issues that were fixed two
releases ago. Ten of the fourteen this document originally listed as open are
closed.

Of the 11, these are the ones the remaining work touches:

| issue                                                       | what it needs                                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [#3](https://github.com/sidorares/dbus-native/issues/3)     | ✅ the value-shape flip (§5) — the oldest one, closed                                                 |
| [#248](https://github.com/sidorares/dbus-native/issues/248) | ✅ `bigint` becoming the default (§5), closed                                                         |
| [#141](https://github.com/sidorares/dbus-native/issues/141) | proxies (§1)                                                                                          |
| [#104](https://github.com/sidorares/dbus-native/issues/104) | the gap against python-dbus ergonomics                                                                |
| [#228](https://github.com/sidorares/dbus-native/issues/228) | a BlueZ user hunting for `GattService` — the shape of problem `ObjectManager` (§3.1) exists to remove |
| [#263](https://github.com/sidorares/dbus-native/issues/263) | positioning: whether this package is the one to use                                                   |

The rest are usage questions and connection-environment problems
([#96](https://github.com/sidorares/dbus-native/issues/96),
[#158](https://github.com/sidorares/dbus-native/issues/158),
[#115](https://github.com/sidorares/dbus-native/issues/115),
[#85](https://github.com/sidorares/dbus-native/issues/85),
[#297](https://github.com/sidorares/dbus-native/issues/297)), several of which
are themselves DX arguments: nobody opens "callback never received" against a
library whose traffic is inspectable by default.

So the case for this work is no longer "it closes half the tracker". It is that
the tracker is nearly empty and the remaining complaints are about **shape**,
not defects — which is exactly when a library gets to think about ergonomics.
