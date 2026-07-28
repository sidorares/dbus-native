# RELEASE_PLAN.md

How the design in [BIG_FUTURE_PLANS.md](./BIG_FUTURE_PLANS.md) gets delivered
without forking the ecosystem.

Written 2026-07-29. This is the sequencing plan; the API design lives in the
other document and the current backlog in [ROADMAP.md](./ROADMAP.md).

---

## The decision

Two tracks, one package, no new npm name.

1. **`dbus-native/next`** — the modern API from BIG_FUTURE_PLANS, developed as
   a subpath export alongside the existing one. No migration required to keep
   using the classic surface.
2. **A short series of major releases** that fix the genuine defects in the
   _classic_ API — variants, errors, 64-bit — each one narrow enough to
   document and tool properly.

The second track is the departure from "add alongside forever". The reason is
the flag-sprawl failure mode: `ayBuffer: true|false|'view'`, `ReturnLongjs`,
plus a hypothetical `ReturnBigInt` and `variants: 'plain'|'tree'` gives a
combinatorial test matrix and documentation that has to explain the wrong way
first. A deliberate break, well supported, is cheaper for everyone than
permanent duality.

**Why both tracks and not just the majors?** Because some of the design —
`await using`, proxies, async-iterable signals — is not a modified version of
the current API, it is a different shape. Forcing it through the classic
surface would compromise it. And `/next` can move fast under 0.x rules while
the classic track keeps its semver promises.

---

## Why this order

Each major is chosen so its blast radius is small enough to tool for, and so
it unblocks the next one.

| release | theme                        | blast radius              | migration mechanism               |
| ------- | ---------------------------- | ------------------------- | --------------------------------- |
| **0.6** | preparation, all additive    | none                      | —                                 |
| **1.0** | errors are `Error`s          | error-handling paths only | codemod + forward-compatible shim |
| **2.0** | the type system              | every value read          | accessors + lint + compat wrapper |
| **3.0** | lifecycle and cancellation   | connection setup/teardown | codemod + deprecations            |
| **4.0** | ESM, `/next` becomes default | imports                   | codemod                           |

Errors come before types because a rejected promise has to carry an `Error` for
promises to be worth anything, and because it touches only `catch` blocks
rather than every value in the program. Types come before lifecycle because it
is the highest-value change and the one people are actually waiting for. ESM
comes last because it is the one break with no functional benefit — it is
packaging, and it can wait until everything else has settled.

---

## 0.6 — preparation (no breaking changes)

The most important release in the plan. Everything here is additive, and its
job is to let people write code that works **both before and after** each
subsequent major.

**Promises alongside callbacks.** [#295](https://github.com/sidorares/dbus-native/pull/295)
is +15/−3 and already does this: return a promise when no callback is given.
Merge it, extend it to `bus.invoke` and the proxy surface.
Closes [#9](https://github.com/sidorares/dbus-native/issues/9),
[#10](https://github.com/sidorares/dbus-native/pull/10).

**Forward-compatible error properties.** Today a failed call delivers the
message body — an array. In 0.6 that array also carries the properties the 1.0
`DBusError` will have:

```js
// 0.6: the array is still an array, but gains properties
Object.assign(body, {
  name: 'DBusError',
  message: body[0] ?? errorName,
  dbusName: errorName
});
```

So this works identically in 0.6 and in 1.0:

```js
bus.invoke(msg, err => {
  if (err?.dbusName === 'org.freedesktop.DBus.Error.ServiceUnknown') {
    /* ... */
  }
});
```

Users migrate at their own pace, on a released version, with no flag day.

**Forward-compatible value accessors.** The same trick for the type system.
Exported from 0.6, these work on _both_ the classic tree shape and the 2.0
plain shape:

```js
import { variantValue, toPlain } from 'dbus-native';

const udi = variantValue(entry); // classic: entry[1][0]; 2.0: entry
const props = toPlain(dict); // classic: array of pairs; 2.0: identity
```

Code written against these survives 2.0 untouched. This is the single most
useful thing in the plan, and it costs almost nothing.

**Deprecation warnings with codes**, following Node's own convention:

```
(node:12345) [DBUS_DEP0002] DeprecationWarning: Reading a variant as
    [signature, [value]] is deprecated and changes in 2.0. Use
    variantValue(). See https://github.com/sidorares/dbus-native/blob/master/docs/deprecations.md#dbus_dep0002
```

Each code gets a documentation anchor, and `--throw-deprecation` turns them
into thrown errors so a consumer's own test suite locates the call sites:

```sh
node --throw-deprecation ./node_modules/.bin/mocha
```

**Correction to an earlier draft of this plan:** that only works for
deprecations whose trigger _is_ a call the user makes — passing `ReturnLongjs`,
calling `connection.end()`. It does **not** work for the value-shape changes in
2.0. A warning there would have to fire inside the parser when the value is
read, so the stack would point at this library rather than at the line that
unpacks the value: it would tell you that you are affected without telling you
where. Those codes are therefore documentation-only, and finding call sites is
the lint rule's job. `docs/deprecations.md` labels each code **runtime** or
**documentation** so the distinction is visible at the point of use.

Warnings fire once per code per process, so normal runs stay quiet.

**Also in 0.6, all additive:** `AbortSignal` on calls,
`diagnostics_channel` instrumentation, a hand-written `index.d.ts`
([#276](https://github.com/sidorares/dbus-native/issues/276)), and the first
`/next` preview.

---

## 1.0 — errors are Errors

**Closes** [#39](https://github.com/sidorares/dbus-native/issues/39),
[#178](https://github.com/sidorares/dbus-native/issues/178),
[#207](https://github.com/sidorares/dbus-native/issues/207),
[#208](https://github.com/sidorares/dbus-native/issues/208).
**Absorbs** [#213](https://github.com/sidorares/dbus-native/pull/213).

| before                                               | after                                   |
| ---------------------------------------------------- | --------------------------------------- |
| `err` is the message body array                      | `err` is a `DBusError`                  |
| `err` is `[]` for an empty body                      | `err.message` is the D-Bus error name   |
| missing interface → `(null, undefined)`              | rejects with `UnknownInterfaceError`    |
| connection dies → pending callbacks dropped silently | all reject with `ConnectionClosedError` |

Anyone who followed the 0.6 warnings already uses `err.dbusName` and
`err.message`, and needs no change at all.

**Codemod** for those who did not:

```sh
npx dbus-native codemod errors-to-error-objects src/
```

```diff
  bus.invoke(msg, (err, result) => {
-   if (err) return reject(new Error(err[0]));
+   if (err) return reject(err);
  });
```

It rewrites `err[0]` to `err.message` and unwraps `new Error(err[0])`, but only
inside callbacks it can identify as D-Bus callbacks by call-site shape.
Anything ambiguous is left alone and reported, because a codemod that guesses
wrong in an error path is worse than one that does nothing.

**Escape hatch:** `dbus-native/compat` exports `toClassicError(err)` returning
the old array. Deliberately in a subpath, not an option on the core — it is
greppable, obviously temporary, and deletable in one commit.

---

## 2.0 — the type system

**Closes** [#3](https://github.com/sidorares/dbus-native/issues/3),
[#67](https://github.com/sidorares/dbus-native/issues/67),
[#91](https://github.com/sidorares/dbus-native/issues/91),
[#114](https://github.com/sidorares/dbus-native/issues/114),
[#132](https://github.com/sidorares/dbus-native/issues/132),
[#147](https://github.com/sidorares/dbus-native/issues/147),
[#248](https://github.com/sidorares/dbus-native/issues/248).
**Supersedes** [#143](https://github.com/sidorares/dbus-native/pull/143),
[#252](https://github.com/sidorares/dbus-native/pull/252).

The one people are waiting for, and the one needing the most support.

| D-Bus            | 1.x                                     | 2.0                                            |
| ---------------- | --------------------------------------- | ---------------------------------------------- |
| `v`              | `[parsedTree, [value]]`                 | the value; `Variant` when explicitly requested |
| `a{sv}`, `a{ss}` | array of pairs                          | plain object                                   |
| `x`, `t`         | lossy `number`, or Long.js under a flag | **`bigint`**                                   |
| `ay`             | `Buffer`                                | `Buffer` — see below                           |

```js
// 1.x
const udi = dict.find(([k]) => k === 'Udi')[1][1][0];

// 2.0
const { Udi } = await device.props.$all;
```

**`ay` should stay a `Buffer`.** BIG_FUTURE_PLANS proposed `Uint8Array` on
web-standards grounds, and having thought about it for delivery I think that is
wrong and I would drop it. `Buffer` _is_ a `Uint8Array` subclass, so anything
accepting the latter already accepts the former, while the reverse is not true:
`buf.toString('utf8')` is used constantly and does not exist on a plain
`Uint8Array`. Breaking it costs real user code and buys almost nothing in a
Node-only library.

**`bigint` is the sharp edge**, and the docs must lead with it rather than bury
it. It is not a drop-in for `number`:

```js
size + 1; // TypeError: Cannot mix BigInt and other types
JSON.stringify({ size }); // TypeError: Do not know how to serialize a BigInt
size > 100; // fine, comparisons work
Number(size); // fine, if you accept the precision loss you already had
```

Every 64-bit value in a program that touches JSON or arithmetic needs
attention. This is the single largest source of migration pain in the plan and
deserves its own guide page.

**Migration mechanisms**, in the order users should reach for them:

1. **The 0.6 accessors.** Code using `variantValue()`/`toPlain()` needs no
   change. This is why 0.6 matters.
2. **A lint rule**, not a codemod, for the residual cases. Reading a variant is
   `result[1][1][0]` — an index chain a codemod cannot safely rewrite because
   it has no idea what the value is. So we flag rather than transform:

   ```sh
   npx dbus-native lint src/
   src/net.js:42  DBUS_DEP0002  variant index chain `[1][1][0]`
                                 -> variantValue(), or `.Udi` after 2.0
   ```

   Being honest about this is important: **there is no complete codemod for
   2.0.** Anyone promising one has not thought about it. The tooling narrows
   the problem to a reviewed list of call sites.

3. **`dbus-native/compat`** for code that cannot be migrated yet:

   ```js
   import { withClassicTypes } from 'dbus-native/compat';
   const bus = withClassicTypes(await sessionBus()); // 1.x shapes, on 2.0
   ```

   A wrapper, not a mode. It cannot leak into unrelated code, and deleting it
   is one line.

---

## 3.0 — lifecycle and cancellation

**Closes** [#20](https://github.com/sidorares/dbus-native/issues/20),
[#137](https://github.com/sidorares/dbus-native/issues/137).

- `Symbol.asyncDispose` on connections, subscriptions and name registrations.
- `connection.end()` → `await bus.close()`, which flushes pending writes and
  fails in-flight calls cleanly instead of throwing
  `ERR_STREAM_WRITE_AFTER_END` — which is what #20 still does today, as
  confirmed during the audit.
- A **default call timeout**. This one is breaking in an unusual direction: it
  makes previously-hanging calls start failing. That is the point, but it
  belongs in a major and needs a loud release note, plus `timeout: 0` to opt
  out.

Codemoddable: `bus.connection.end()` → `await bus.close()` is a mechanical
rewrite.

Note the library implements `Symbol.asyncDispose` regardless of the consumer's
Node version — only the `using` _keyword_ needs Node 24, and that is the user's
choice, not a floor we impose. The engines floor stays at 20.8 here.

---

## 4.0 — ESM, and `/next` becomes the default

- `dbus-native` resolves to the modern API; the classic surface moves to
  `dbus-native/classic` and stays supported for a defined period.
- ESM-only with a real `exports` map. Not dual: a dual package means two copies
  of `Variant`, and `instanceof` failing across them is a genuine hazard for a
  library whose whole point is value wrapping.
- Node floor rises to whatever `/next` needs.

Deferrable. If appetite is low, 3.0 and 4.0 merge, or 4.0 waits a year — it is
the only break in the plan with no functional payoff.

---

## The `/next` track

Runs in parallel from 0.6, versioned by the package but explicitly unstable
until 4.0:

```js
import { sessionBus } from 'dbus-native/next'; // 0.x rules apply here
```

Documented as experimental in the README, with breaking changes allowed in
minors. It shares the wire layer, the test suite and the release process, so it
costs no extra infrastructure — which is the whole reason for preferring a
subpath over a second package.

Convergence: when `/next` covers what the classic API does and has real users,
4.0 swaps the default. If it never gets there, the classic track has still had
three majors of genuine improvement and nothing is stranded.

---

## Machinery to build first

Ordered by how much they unblock:

1. **`docs/deprecations.md`** with `DBUS_DEP0001…` anchors, and a
   `deprecate(code, message)` helper that warns once per code.
2. **The 0.6 forward-compatible accessors** — `variantValue`, `toPlain`,
   error properties. Small, and every later migration leans on them.
3. **`npx dbus-native codemod <name>`** on jscodeshift, with fixture-based
   tests. Codemods ship _in the package_ so the version that breaks you also
   contains the fix.
4. **`npx dbus-native lint`** for the patterns codemods cannot safely rewrite.
   ast-grep rules are enough; this does not need to be a real ESLint plugin
   initially.
5. **A migration guide per major** — `docs/migrating-to-1.md` and so on — with
   a before/after table for every changed behaviour, not prose.

---

## Ecosystem coordination

The download split makes this the highest-leverage item in the plan, and it is
not a technical one:

| package                   | weekly                      | share |
| ------------------------- | --------------------------- | ----- |
| `@homebridge/dbus-native` | 40,827                      | 61%   |
| `dbus-next`               | 19,273 (dormant since 2022) | 28%   |
| `dbus-native`             | 7,370                       | 11%   |

Roughly nine in ten users of this codebase consume it through the Homebridge
fork. A major series they do not follow is not a migration, it is a permanent
split.

Concretely: talk to them before 1.0 ships, not after. Their fork exists because
upstream went quiet; upstream is now demonstrably not quiet, their three deltas
are already resolved here, and the `long.js` ARMv6 workaround that forced them
to vendor a fork disappears at 2.0 when `bigint` lands. Offer them a say in the
1.0 error shape — the cost of that conversation is an email and the cost of
skipping it is the whole plan.

Separately: [#263](https://github.com/sidorares/dbus-native/issues/263) should
be closed with a statement of direction. It has been ambiguous since 2019, and
this plan is the answer to it.

---

## Risks

**The 0.6 accessors go unused.** They only pay off if people adopt them, which
means the deprecation warnings have to actually fire in the paths that matter
and the docs have to lead with them. If 0.6 lands quietly, 2.0 hurts.

**Major fatigue.** Four majors in a package that shipped one release in four
years is a lot of churn. Mitigation: no fixed schedule, ship each when it is
ready and documented, and be willing to merge 3.0 and 4.0.

**`/next` half-finished.** The failure mode of #251, and of `dbus-next` itself.
Mitigation: the classic track delivers value independently, so `/next` stalling
costs nothing but the subpath.

**`bigint` in 2.0 is underestimated.** I would rather over-invest in that guide
than under-invest. Consider shipping 2.0 with `bigint` behind an opt-in for one
minor, then flipping — the one place a temporary flag genuinely earns its keep,
because the failure mode is a `TypeError` in production rather than a subtly
wrong value.

**The plan outlives its usefulness.** It assumes maintainer time that may not
materialise. Everything before 1.0 is additive, so the honest fallback is to
ship 0.6 and stop: promises, types, `AbortSignal`, deprecation warnings and
accessors are worthwhile on their own, and leave the project better even if no
major ever follows.
