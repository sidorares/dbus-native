# BIG_FUTURE_PLANS.md

What `dbus-native` could look like if it were designed today, with backwards
compatibility off the table.

Written 2026-07-28, after the 0.5.0 wire-layer work. This is a **design sketch
for review, not a commitment and not implemented** — none of the code below
runs. Where a proposal has a real problem I have said so rather than glossed
over it; see §14 for the parts I would cut.

Two things ground it, so it is not a wishlist:

- **The issue tracker.** Nearly every proposal here closes issues that have
  been open for years. They are cited inline.
- **What actually shipped in JavaScript.** Feature availability was checked on
  Node 26 rather than assumed, and §13 records what is genuinely available
  versus what still needs a transpiler.

---

## 0. What is actually wrong today

Not opinions — these are the recurring themes in the tracker.

**Reading a value means walking the parser's internal tree.** From
[#67](https://github.com/sidorares/dbus-native/issues/67), the answer a user
was given for extracting one string out of an `a{sv}`:

```js
const dict = [
  ['Udi', [[{ type: 's', child: [] }], ['/sys/devices/.../wlan0']]]
];
const value = dict.find(([key]) => key === 'Udi')[1][1][0];
//                                              ^^^^^^^^^ parsed signature, then value, then unwrap
```

Same complaint in [#3](https://github.com/sidorares/dbus-native/issues/3),
[#132](https://github.com/sidorares/dbus-native/issues/132),
[#147](https://github.com/sidorares/dbus-native/issues/147),
[#52](https://github.com/sidorares/dbus-native/issues/52),
[#104](https://github.com/sidorares/dbus-native/issues/104). It is the single
most-reported problem in the project's history.

**Errors are not Errors.** From
[#207](https://github.com/sidorares/dbus-native/issues/207) — a failed call
hands the callback an _array of strings_:

```js
bus.invoke(msg, (err, result) => {
  // err === [ 'The name net.connman was not provided by any .service files' ]
  // no stack, no .name, no way to switch on the error, sometimes just []
});
```

[#178](https://github.com/sidorares/dbus-native/issues/178) is the same thing
with an empty body, where `err` is `[]` — falsy-adjacent and easy to miss.

**Everything is a callback.** [#9](https://github.com/sidorares/dbus-native/issues/9)
was opened in 2013 and is still open.
[#10](https://github.com/sidorares/dbus-native/pull/10) and
[#295](https://github.com/sidorares/dbus-native/pull/295) are both unmerged
promise PRs, thirteen and three years old.

**No types.** [#276](https://github.com/sidorares/dbus-native/issues/276).

**No timeouts, no cancellation.** [#137](https://github.com/sidorares/dbus-native/issues/137).
A call whose reply never arrives leaks its entry in `bus.cookies` forever.

**Nothing is cleaned up.** Match rules, owned names and the connection itself
all have to be released by hand, and
[#20](https://github.com/sidorares/dbus-native/issues/20) shows that even
closing the connection at the wrong moment throws.

**Boilerplate before you can do anything.** The README's own opening example is
three levels of nesting before the first method call.

---

## 1. `await using` connections

**Closes:** [#20](https://github.com/sidorares/dbus-native/issues/20).

A bus connection owns a socket, pending replies, match rules and possibly a
well-known name. Today you release all of that by hand, in the right order, and
`connection.end()` at the wrong moment throws.

Explicit resource management makes the lifetime lexical:

```js
import { sessionBus } from 'dbus-native';

{
  await using bus = await sessionBus();
  const id = await bus.call({/* ... */});
}
// socket closed, pending calls rejected with a clear error, match rules
// removed, owned names released -- in that order, and awaited
```

The library implements `[Symbol.asyncDispose]()`. Consumers on older Node that
lack the `using` _syntax_ can still call `await bus.close()` — the protocol and
the keyword are separable, so implementing it costs nothing.

`DisposableStack` composes several resources, which is exactly the shape of a
service that owns a name, exports objects and subscribes to signals:

```js
await using stack = new AsyncDisposableStack();
const bus = stack.use(await sessionBus());
stack.use(await bus.requestName('com.example.Greeter'));
stack.use(await bus.export('/com/example/Greeter', greeter));
stack.use(
  await bus.watch("type='signal',interface='org.freedesktop.NetworkManager'")
);

await stack.defer(() => console.log('shutting down'));
// everything unwinds in reverse order, whether we leave normally or throw
```

Today the equivalent is a `try/finally` pyramid that nobody writes, which is
why processes leak match rules.

---

## 2. Proxies: the object _is_ the remote object

**Closes:** [#88](https://github.com/sidorares/dbus-native/issues/88),
[#141](https://github.com/sidorares/dbus-native/issues/141),
and the core of [#104](https://github.com/sidorares/dbus-native/issues/104) —
where this exact design was discussed in 2016 and rejected because
"older node versions would require `--harmony-proxies`". That objection expired
years ago.

Today:

```js
sessionBus
  .getService('org.freedesktop.Notifications')
  .getInterface(
    '/org/freedesktop/Notifications',
    'org.freedesktop.Notifications',
    (err, notifications) => {
      if (err) throw err;
      notifications.Notify(
        'app',
        0,
        '',
        'summary',
        'body',
        [],
        [],
        5000,
        (err, id) => {
          /* ... */
        }
      );
    }
  );
```

Proposed:

```js
const notifications = await bus.proxy(
  'org.freedesktop.Notifications',
  '/org/freedesktop/Notifications'
);

const id = await notifications.Notify(
  'app',
  0,
  '',
  'summary',
  'body',
  [],
  {},
  5000
);
```

`proxy()` introspects once, caches the result per (service, path), and returns
a `Proxy` whose `get` trap resolves a member name against the interfaces found
there. Method arguments are marshalled against the _introspected_ signature,
which is what lets callers pass plain JS — the type information comes from the
bus, not from the caller.

Where a member name is ambiguous across two interfaces on the same object, the
trap throws with both candidates named, and you disambiguate explicitly:

```js
const player = await bus.proxy(
  'org.mpris.MediaPlayer2.vlc',
  '/org/mpris/MediaPlayer2',
  {
    interface: 'org.mpris.MediaPlayer2.Player'
  }
);
```

Properties read as if they were properties, because a `get` trap can return a
promise and `await` does the rest:

```js
const metadata = await player.props.Metadata; // a{sv} -> plain object
const { Devices } = await nm.props.$all; // GetAll in one round trip
```

Writes cannot use assignment — `obj.x = v` evaluates to `v`, not to a promise,
so there is nothing to await and a failed write would be silently lost. Rather
than pretend, writes are explicit:

```js
await player.props.$set('Volume', 0.5);
await player.props.$set({ Volume: 0.5, Shuffle: true }); // batched
```

This is the one place I would accept slight asymmetry over a footgun.

---

## 3. Variants and the type system

**Closes:** [#3](https://github.com/sidorares/dbus-native/issues/3),
[#67](https://github.com/sidorares/dbus-native/issues/67),
[#91](https://github.com/sidorares/dbus-native/issues/91),
[#114](https://github.com/sidorares/dbus-native/issues/114),
[#132](https://github.com/sidorares/dbus-native/issues/132),
[#147](https://github.com/sidorares/dbus-native/issues/147).
Supersedes [#143](https://github.com/sidorares/dbus-native/pull/143).

The rule: **D-Bus types map to the closest JS type, and the parser's internal
tree never escapes.**

| D-Bus               | today                                | proposed                           |
| ------------------- | ------------------------------------ | ---------------------------------- |
| `s` `o` `g`         | string                               | string                             |
| `y` `n` `q` `i` `u` | number                               | number                             |
| `x` `t`             | `number` (lossy) or a Long.js object | **`bigint`**                       |
| `d`                 | number                               | number                             |
| `b`                 | boolean                              | boolean                            |
| `ay`                | Buffer                               | `Uint8Array`                       |
| `a{sv}`             | array of `[key, [tree, [value]]]`    | **plain object**                   |
| `a{ss}`             | array of pairs                       | plain object                       |
| `as`                | array                                | array                              |
| `(...)`             | array                                | array (tuple)                      |
| `v`                 | `[tree, [value]]`                    | the value, or `Variant` when asked |

So [#67](https://github.com/sidorares/dbus-native/issues/67) becomes:

```js
const { Udi } = await device.props.$all;
```

Type information is not lost, it just stops being mandatory. When a value is
genuinely ambiguous — writing a `v`, or a numeric type the signature does not
pin down — there is an explicit wrapper:

```js
import { Variant } from 'dbus-native';

await notifications.Notify(
  'app',
  0,
  '',
  'summary',
  'body',
  [],
  {
    urgency: new Variant('y', 1),
    'sound-name': 'message-new-instant' // plain string infers 's'
  },
  5000
);
```

and reading can ask for it back:

```js
const raw = await player.props.$variant('Metadata');
raw.signature; // 'a{sv}'
raw.value; // the plain object
```

`Variant` implements `util.inspect.custom`, so `console.log` shows
`Variant('y', 1)` rather than a wall of parse-tree objects — a small thing that
makes the debugging loop enormously better.

**64-bit becomes `bigint`.** This is [ROADMAP §3.2](./ROADMAP.md) and
[#248](https://github.com/sidorares/dbus-native/issues/248), and it also
removes the last non-trivial runtime dependency along with the `long.js` ARMv6
crash that forced the Homebridge fork to vendor its own copy.

```js
const bytes = await disk.props.Size; // 2000398934016n
```

**Marshalling a plain object** as `a{sv}` closes the `// TODO: serialise JS
objects as a{sv}` that has been in `marshall.js` for a decade, and the disabled
test in `test/js-types.js` that has been waiting for it just as long.

---

## 4. Errors that are Errors

**Closes:** [#178](https://github.com/sidorares/dbus-native/issues/178),
[#207](https://github.com/sidorares/dbus-native/issues/207),
[#208](https://github.com/sidorares/dbus-native/issues/208),
[#39](https://github.com/sidorares/dbus-native/issues/39).

I verified during the audit that `getInterface` on a missing interface still
calls back `(null, undefined)` today — no error at all, which is
[#39](https://github.com/sidorares/dbus-native/issues/39) and
[#208](https://github.com/sidorares/dbus-native/issues/208) exactly.

```js
class DBusError extends Error {
  name = 'DBusError';
  dbusName; // 'org.freedesktop.DBus.Error.ServiceUnknown'
  body; // the raw arguments, for the rare caller that wants them
  reply; // the full message
}
```

Which makes the natural thing work:

```js
try {
  await notifications.Notify(/* ... */);
} catch (err) {
  if (err.dbusName === 'org.freedesktop.DBus.Error.ServiceUnknown') {
    // start it, fall back, whatever
  }
  throw err; // with a real stack, and .cause set where we wrapped something
}
```

Named subclasses for the errors people actually branch on —
`ServiceUnknownError`, `NoReplyError`, `AccessDeniedError`, `TimeoutError` —
so `err instanceof NoReplyError` works without string comparison.

**Async stack traces are the real prize.** Today a failed call gives you a
stack rooted in the socket read handler, with no trace of your own code.
Promise rejections carry the caller's frames, so the stack points at the line
that made the call.

---

## 5. Signals as async iterables

**Closes:** [#75](https://github.com/sidorares/dbus-native/issues/75),
[#117](https://github.com/sidorares/dbus-native/issues/117),
[#136](https://github.com/sidorares/dbus-native/issues/136),
[#138](https://github.com/sidorares/dbus-native/issues/138).

Two shapes, because both are legitimate.

**Callback, with a disposable subscription** — the match rule is removed when
the scope exits, which is the bug nobody remembers to fix by hand:

```js
using sub = await nm.on('StateChanged', state => console.log(state));
```

**Async iteration**, which composes with everything else:

```js
for await (const [state] of nm.signal('StateChanged')) {
  if (state === NM_STATE_CONNECTED_GLOBAL) break; // <- removes the match rule
}
```

Breaking out of a `for await` calls the iterator's `return()`, so the
subscription is torn down by the language rather than by discipline. Combined
with `AbortSignal`:

```js
const changes = nm.signal('PropertiesChanged', {
  signal: AbortSignal.timeout(30_000)
});
for await (const [iface, changed] of changes) {
  console.log(changed); // plain object, per §3
}
```

Note the honest caveat: **async iterator helpers are not in Node yet** (checked
on 26), so `.map()`/`.filter()`/`.take()` on these streams are not available
without a helper library. Async _generators_ are, so composing by hand works
fine.

A `queueing` option decides what happens when the consumer is slower than the
bus — drop, buffer to a bound, or apply backpressure. Silently unbounded
buffering is how this design usually goes wrong.

---

## 6. Cancellation and timeouts

**Closes:** [#137](https://github.com/sidorares/dbus-native/issues/137).
Supersedes [#213](https://github.com/sidorares/dbus-native/pull/213).

Every call takes an `AbortSignal`, and there is a default timeout:

```js
const bus = await sessionBus({ timeout: 25_000 }); // default for all calls

await slowThing.DoIt({ signal: AbortSignal.timeout(5_000) });

const ac = new AbortController();
process.on('SIGINT', () => ac.abort());
await longRunning.Watch({ signal: ac.signal });
```

Aborting rejects with `AbortError` **and removes the pending-reply entry**,
which is the actual leak today: `bus.cookies` grows forever for any call whose
reply never arrives. A long-lived daemon leaks in proportion to how often its
peers misbehave.

Combined with `Promise.withResolvers()` (available now), the internal
pending-call table gets much simpler than the current cookie-plus-callback
scheme.

---

## 7. Defining a service

**Closes:** [#81](https://github.com/sidorares/dbus-native/issues/81),
[#89](https://github.com/sidorares/dbus-native/issues/89),
[#230](https://github.com/sidorares/dbus-native/issues/230),
[#309](https://github.com/sidorares/dbus-native/issues/309).

The current descriptor format is positional arrays — `Echo: ['s', 's',
['input'], ['output']]` — where the meaning of each slot has to be memorised,
and there is no way to declare that a property is read-only
([#89](https://github.com/sidorares/dbus-native/issues/89)).

**No build step required:**

```js
import { defineInterface, signal } from 'dbus-native';

const greeter = defineInterface({
  name: 'com.example.Greeter',
  methods: {
    Hello: {
      in: { name: 's' },
      out: { greeting: 's' },
      handler: ({ name }, { sender }) => `Hello, ${name}, from ${sender}`
    }
  },
  properties: {
    Language: { type: 's', access: 'read', get: () => currentLanguage },
    Volume: {
      type: 'd',
      access: 'readwrite',
      get: () => volume,
      set: v => {
        volume = v;
      } // PropertiesChanged emitted automatically
    }
  },
  signals: {
    Greeted: { args: { who: 's' } }
  }
});

await using registration = await bus.export('/com/example/Greeter', greeter);
greeter.emit.Greeted('world');
```

Three things fall out of this that are currently missing or broken:

- `access: 'read'` is _enforced_, and reaches the introspection XML instead of
  the hardcoded `access="readwrite"` that everything gets today.
- `PropertiesChanged` is emitted on write, which is
  [#81](https://github.com/sidorares/dbus-native/issues/81) and
  [#117](https://github.com/sidorares/dbus-native/issues/117).
- Handlers receive a **context** with `sender`, `path` and an `AbortSignal`, so
  [#230](https://github.com/sidorares/dbus-native/issues/230) is a named
  parameter rather than a documented accident of argument order.

Interface and member names are validated on export
([#309](https://github.com/sidorares/dbus-native/issues/309)).

**Decorators, for TypeScript users only.** This reads better:

```ts
@iface('com.example.Greeter')
class Greeter {
  @method({ in: { name: 's' }, out: { greeting: 's' } })
  Hello(name: string) {
    return `Hello, ${name}`;
  }

  @property({ type: 'd', access: 'readwrite' })
  accessor volume = 0.5;
}
```

but **decorators are still not native** — I checked on Node 26 and the syntax
is a `SyntaxError`. Shipping this as the primary API would force a build step
on every consumer, which contradicts the no-build-step property this package is
valued for. So: `defineInterface` is the API, decorators are an optional export
for people who already have a TypeScript pipeline.

---

## 8. Types without a build step

**Closes:** [#276](https://github.com/sidorares/dbus-native/issues/276).

Three layers, in increasing order of magic.

**A hand-written `index.d.ts`** for the library itself. Table stakes, and the
thing most likely to be driving users to `dbus-next`.

**A codegen CLI** — the modern replacement for `dbus2js`, which currently
generates ES5 string-concatenated code:

```
$ npx dbus-native types --system \
    --service org.freedesktop.NetworkManager \
    --path /org/freedesktop/NetworkManager \
    > src/generated/network-manager.d.ts
```

```ts
import type { NetworkManager } from './generated/network-manager.js';

const nm = await bus.proxy<NetworkManager>(
  'org.freedesktop.NetworkManager',
  '/org/freedesktop/NetworkManager'
);
await nm.GetDeviceByIpIface('eth0'); // fully typed, checked at compile time
```

**A module customization hook**, for the case where the introspection XML is
checked into the repo. `module.register()` is available now:

```js
// register once, in the app entry point
import { register } from 'node:module';
register('dbus-native/loader', import.meta.url);
```

```js
// then an XML file imports as a typed client factory
import connectNetworkManager from './network-manager.xml' with { type: 'dbus' };

await using nm = await connectNetworkManager(bus);
```

I want to be straight about this last one: it is the most fashionable idea here
and the least useful. It saves one codegen step, costs a loader registration in
every consumer, breaks bundlers, and confuses every tool that does not know
about import attributes. **I would build the first two and prototype the third
behind a flag**, and drop it if it does not earn its keep. It is in this
document because you asked what is possible, not because I think it is wise.

---

## 9. ESM, and the shape of the package

Native ESM, with a real `exports` map:

```json
{
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./next": "./lib/next/index.js",
    "./classic": "./lib/classic/index.js",
    "./compat": "./lib/compat.js",
    "./variant": "./lib/variant.js",
    "./testing": "./lib/testing.js"
  }
}
```

Three deliberate choices:

- **This API ships as `dbus-native/next`** while it is being built, alongside
  the existing surface, and becomes the default only once it has real users.
  One package, one repo, one test suite — see
  [RELEASE_PLAN.md](./RELEASE_PLAN.md) for the sequencing.
- **ESM-only, not dual**, at the point the default flips. Dual packages cause
  the "two copies of the same class" problem, which for a library exporting a
  `Variant` that people `instanceof` is a genuine hazard, not a theoretical
  one.
- **`./compat` holds the migration shims**, in a subpath rather than as options
  on the core, so they are greppable, obviously temporary, and deletable in one
  commit.

**No Node 24 floor is required.** I said otherwise in an earlier draft and it
was wrong: the library implements `Symbol.asyncDispose` on any Node that has
the symbol (20.9+), and only _consumer_ code writing the `using` keyword needs 24. That is the user's choice, not a floor we impose — which matters for a
library whose users skew embedded and Raspberry Pi.

---

## 10. Observability

A protocol library is a natural place for `diagnostics_channel`, which costs
nothing when nobody subscribes:

```js
import diagnostics_channel from 'node:diagnostics_channel';

diagnostics_channel.subscribe('dbus:call:start', ({ destination, member }) => {
  console.log('->', destination, member);
});
```

That gives OpenTelemetry integration, a `dbus-monitor` equivalent, and
per-call timing without a debug-logging API of our own. Given how many issues
in this tracker are "I sent something and nothing happened"
([#115](https://github.com/sidorares/dbus-native/issues/115),
[#136](https://github.com/sidorares/dbus-native/issues/136),
[#138](https://github.com/sidorares/dbus-native/issues/138),
[#229](https://github.com/sidorares/dbus-native/issues/229)), making traffic
inspectable is probably worth more than any single API improvement here.

---

## 11. Testing DX

The integration harness added in 0.5.0 already starts a private `dbus-daemon`.
The missing piece is an **in-process bus**, which would make tests hermetic and
remove the `brew install dbus` step for contributors:

```js
import { test } from 'node:test';
import { testBus } from 'dbus-native/testing';

test('greets', async t => {
  await using bus = await testBus(); // in-process, no daemon
  await using _ = await bus.export('/com/example/Greeter', greeter);

  const client = await bus.proxy('com.example.Greeter', '/com/example/Greeter');
  t.assert.strictEqual(await client.Hello('world'), 'Hello, world');
});
```

This is [ROADMAP §4.5](./ROADMAP.md) — `lib/server.js` is currently a stub
whose handshake replies with a GUID hardcoded from someone's 2014 session.
Finishing it pays off twice: contributors stop needing a system dependency, and
the server side stops being a liability.

---

## 12. Putting it together

The README's opening example, today versus proposed:

```js
// today
var dbus = require('dbus-native');
var sessionBus = dbus.sessionBus();
sessionBus
  .getService('org.freedesktop.Notifications')
  .getInterface(
    '/org/freedesktop/Notifications',
    'org.freedesktop.Notifications',
    function (err, notifications) {
      if (err) throw err;
      notifications.on('ActionInvoked', function () {
        console.log('ActionInvoked', arguments);
      });
      notifications.Notify(
        'exampl',
        0,
        '',
        'summary 3',
        'new message text',
        ['xxx yyy', 'test2'],
        [],
        5,
        function (err, id) {}
      );
    }
  );
```

```js
// proposed
import { sessionBus } from 'dbus-native';

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
  'new message text',
  ['default', 'Open'],
  { urgency: new Variant('y', 1) },
  5_000
);

for await (const [closedId, reason] of notifications.signal(
  'NotificationClosed'
)) {
  if (closedId === id) break;
}
```

Nine lines instead of sixteen, no callbacks, no `arguments`, errors that throw,
and every resource released on the way out.

---

## 13. Feature availability, checked

Verified on Node 26 rather than assumed, because a plan built on a feature that
does not exist is worse than no plan:

| feature                                    | status                                | used for           |
| ------------------------------------------ | ------------------------------------- | ------------------ |
| `using` / `Symbol.dispose`                 | ✅ native (syntax: Node 24+)          | §1, §5, §7         |
| `DisposableStack` / `AsyncDisposableStack` | ✅ native                             | §1                 |
| `Promise.withResolvers()`                  | ✅ native                             | §6                 |
| `Array.fromAsync()`                        | ✅ native                             | §5                 |
| Sync iterator helpers                      | ✅ native                             | §5                 |
| `AbortSignal.timeout()`                    | ✅ native                             | §6                 |
| `Error.cause`                              | ✅ native                             | §4                 |
| `module.register()` hooks                  | ✅ native                             | §8                 |
| Proxy                                      | ✅ native since forever               | §2                 |
| BigInt                                     | ✅ native                             | §3                 |
| **Async iterator helpers**                 | ❌ **not available**                  | would have been §5 |
| **Decorators**                             | ❌ **not native, needs a transpiler** | §7, opt-in only    |

---

## 14. Risks, and what I would cut

**What I would cut.**

- **The `dbus:` import specifier and the XML loader** (§8). Fashionable,
  fragile, breaks bundlers. Prototype behind a flag, drop if it does not earn
  its keep.
- **Decorators as the primary service API** (§7). Not native. Forcing a build
  step on consumers contradicts the property this package is valued for.
- **Auto-inferring signatures from plain JS on the write path** where no
  introspected signature is available. `{ a: 1 }` could be `a{sy}`, `a{si}`,
  `a{su}`, `a{sd}`, `a{sv}` — this is exactly the data-loss argument from
  [#52](https://github.com/sidorares/dbus-native/issues/52), and it was right
  then. Infer only where the signature is known; require `Variant` otherwise.

**Real risks.**

- **This is a rewrite of the public API, not a refactor.** The wire layer
  (marshaller, parser, framing) is now good and should be kept as-is — the work
  is all above it. Rewriting the parts that were just measured and hardened
  would be the way to turn a 2× improvement into a regression.
- **Two live packages** is how `dbus-next` and this package both ended up
  half-maintained. Whatever ships must be _this_ package, not a third one.
  [#263](https://github.com/sidorares/dbus-native/issues/263) is the cautionary
  tale.
- **~7.4k weekly downloads depend on the current API**, plus ~41k on the
  Homebridge fork which tracks it closely. A clean break has to come with a
  codemod or a genuinely good migration guide, or it forks the ecosystem again.
- **Scope.** Everything here is maybe six months of evenings. The sequencing
  below front-loads the parts that stand alone.

**Suggested order** — superseded by [RELEASE_PLAN.md](./RELEASE_PLAN.md),
which turns this into a dated release train with migration tooling. Kept here
because the reasoning about value-per-unit-of-risk still holds:

1. **Promises** (§4 errors, §6 timeouts) — additive, unblocks everything else,
   and [#295](https://github.com/sidorares/dbus-native/pull/295) is a
   +15/−3 starting point.
2. **`bigint` for 64-bit** (§3) — drops the last real dependency.
3. **Plain-JS variants** (§3) — the biggest single ergonomic win, and closes
   the most issues.
4. **Proxies** (§2) and **async-iterable signals** (§5).
5. **`await using`** (§1) and the new service API (§7).
6. **Types** (§8), then ESM (§9).

Steps 1–3 could ship as `1.0` under the existing API shape. Steps 4–6 are the
break.

---

## Appendix: issues this would close

Directly, if all of it landed: [#3](https://github.com/sidorares/dbus-native/issues/3),
[#9](https://github.com/sidorares/dbus-native/issues/9),
[#20](https://github.com/sidorares/dbus-native/issues/20),
[#39](https://github.com/sidorares/dbus-native/issues/39),
[#67](https://github.com/sidorares/dbus-native/issues/67),
[#72](https://github.com/sidorares/dbus-native/issues/72),
[#75](https://github.com/sidorares/dbus-native/issues/75),
[#81](https://github.com/sidorares/dbus-native/issues/81),
[#88](https://github.com/sidorares/dbus-native/issues/88),
[#89](https://github.com/sidorares/dbus-native/issues/89),
[#91](https://github.com/sidorares/dbus-native/issues/91),
[#114](https://github.com/sidorares/dbus-native/issues/114),
[#117](https://github.com/sidorares/dbus-native/issues/117),
[#132](https://github.com/sidorares/dbus-native/issues/132),
[#137](https://github.com/sidorares/dbus-native/issues/137),
[#141](https://github.com/sidorares/dbus-native/issues/141),
[#147](https://github.com/sidorares/dbus-native/issues/147),
[#178](https://github.com/sidorares/dbus-native/issues/178),
[#207](https://github.com/sidorares/dbus-native/issues/207),
[#208](https://github.com/sidorares/dbus-native/issues/208),
[#230](https://github.com/sidorares/dbus-native/issues/230),
[#236](https://github.com/sidorares/dbus-native/issues/236),
[#248](https://github.com/sidorares/dbus-native/issues/248),
[#276](https://github.com/sidorares/dbus-native/issues/276),
[#309](https://github.com/sidorares/dbus-native/issues/309).

Plus the open PRs it supersedes or absorbs:
[#10](https://github.com/sidorares/dbus-native/pull/10),
[#143](https://github.com/sidorares/dbus-native/pull/143),
[#213](https://github.com/sidorares/dbus-native/pull/213),
[#251](https://github.com/sidorares/dbus-native/pull/251),
[#252](https://github.com/sidorares/dbus-native/pull/252),
[#295](https://github.com/sidorares/dbus-native/pull/295).

That is over half the open tracker, which is the real argument for doing it.
