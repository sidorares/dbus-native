# dbus-native roadmap

Written 2026-07-28, after the maintenance pass that migrated CI to GitHub
Actions, pruned the dependency tree, and modernised the source.

This document triages the open issues and PRs and proposes what to do next. It
is a plan of record, not a promise of dates.

---

## 0. The elephant in the room: positioning

Three packages now serve the same users:

| package                                            | latest | published | downloads/week |
| -------------------------------------------------- | ------ | --------- | -------------- |
| `dbus-native` (this repo)                          | 0.4.0  | 2022-06   | ~7.4k          |
| `dbus-next` (acrisci fork/rewrite)                 | 0.10.2 | 2022-04   | ~19k           |
| `@homebridge/dbus-native` (soft fork of this repo) | 0.7.8  | 2026-07   | ~41k           |

Two things stand out:

- **The Homebridge fork is the de-facto maintained `dbus-native`.** It is a
  light fork of this codebase (dropped `abstract-socket`, swapped `optimist` for
  `minimist`, forked `long.js` for an ARMv6 crash) and it now has more downloads
  than this package and `dbus-next` combined. Its changes are a strict subset of
  what this pass just did — this repo now has three runtime dependencies to
  their six.
- **[#263](https://github.com/sidorares/dbus-native/issues/263) ("Deprecate
  dbus-native") was agreed in principle in 2019 and never executed.** `dbus-next`
  was to take over the npm name; that never happened, and `dbus-next` has itself
  been dormant since 2022.

**Recommendation:** do not deprecate. This repo is the most-forked, most-depended-on
of the three and is now the most modern. Instead:

1. Reach out to the Homebridge maintainers about folding their fork back in.
   Their three deltas are already addressed here except the `long.js` ARMv6
   workaround — which item 2 below removes the need for entirely.
2. Close [#263](https://github.com/sidorares/dbus-native/issues/263) with a note
   explaining the current state, rather than leaving it open and ambiguous.
3. Ship a 0.5.0 from this modernisation pass so the ecosystem sees a signal of
   life.

---

## 1. Next release (0.5.0) — already done in this pass

Landed and verified; listed here so the changelog writes itself.

- Travis → GitHub Actions; matrix over Node 20/22/24 on Linux and macOS.
- release-please with npm **trusted publishing (OIDC)** — no `NPM_TOKEN`, and
  provenance attached automatically.
- Dependabot for npm and GitHub Actions.
- Runtime dependencies cut from 7 (+1 optional native) to **3**
  (`hexy`, `long`, `xml2js`):
  - `abstract-socket` removed — Node ≥ 20.8 supports Linux abstract sockets
    natively via a `\0` path prefix. Fixes the whole class of native-build
    failures ([#193](https://github.com/sidorares/dbus-native/issues/193)).
  - `put` replaced by a 40-line `lib/put.js`
    ([#271](https://github.com/sidorares/dbus-native/issues/271),
    [#262](https://github.com/sidorares/dbus-native/pull/262)).
  - `optimist` replaced by `node:util.parseArgs`
    ([#286](https://github.com/sidorares/dbus-native/issues/286)).
  - `event-stream` replaced by `stream.Duplex.from` — also removes a package
    with a notable supply-chain history.
  - `safe-buffer` removed; `xml2js` → 0.6.2
    ([#294](https://github.com/sidorares/dbus-native/pull/294)).
- `var` → `const`/`let`, arrow callbacks, template literals throughout.
- Real integration tests against a live `dbus-daemon` (12 tests), plus
  `npm run dbus:session` for local development on macOS.
- Bug fixes found along the way:
  - `Properties.Set` assigned the literal `1234` instead of the value sent
    ([#129](https://github.com/sidorares/dbus-native/issues/129)).
  - `Peer.GetMachineId` returned the English sentence
    `"This is a machine id. TODO: implement"`.
  - `getUserHome()` matched on `/$win/`, a regex that can never match, so the
    DBUS_COOKIE_SHA1 keyring path was wrong on Windows.
  - `if (!methods.empty)` — `Array` has no `.empty`, so the auth-fallback branch
    was dead code, and the failure path called back with a `Buffer` instead of
    an `Error`.
  - Placeholder `'Uh oh oh'` D-Bus errors replaced with the correct
    `UnknownObject`/`UnknownInterface`/`UnknownMethod`/`UnknownProperty` names
    and useful messages ([#39](https://github.com/sidorares/dbus-native/issues/39),
    [#207](https://github.com/sidorares/dbus-native/issues/207),
    [#208](https://github.com/sidorares/dbus-native/issues/208) are adjacent).
  - Two examples used `` `...${err}` ? err : '(no error)' `` — a template
    literal is always truthy, so the fallback never ran.

---

## 2. High priority

### 2.1 Promise support for method calls

**Issues:** [#9](https://github.com/sidorares/dbus-native/issues/9),
[#10](https://github.com/sidorares/dbus-native/pull/10),
[#295](https://github.com/sidorares/dbus-native/pull/295)

The single most-requested change, and the biggest ergonomics gap against
`dbus-next`. PR [#295](https://github.com/sidorares/dbus-native/pull/295) is only
+15/-3 in `lib/introspect.js`: if no callback is passed, return a promise. It is
backwards compatible and should be reviewed and merged more or less as-is.

Then go further: add a `bus.invokeAsync(msg)` (or a `promisify: true` client
option) so the low-level API is usable with `await` too, and export the whole
proxy surface as promise-returning. Callback style stays supported.

### 2.2 Replace Long.js with BigInt

**Issue:** [#248](https://github.com/sidorares/dbus-native/issues/248),
**PR:** [#252](https://github.com/sidorares/dbus-native/pull/252)

`BigInt` is native and removes the last non-trivial runtime dependency — and
with it the ARMv6 `long.js` crash that forced the Homebridge fork to vendor
their own copy.

Plan: read `x`/`t` with `readBigInt64LE`/`readBigUInt64LE`; accept
`bigint`, `number`, `string` and `Long`-shaped objects on marshall. Gate the
return type behind an option (`ReturnBigInt`) for one minor release alongside
the existing `ReturnLongjs`, then flip the default in 1.0 and drop `long`.

### 2.3 TypeScript declarations

**Issue:** [#276](https://github.com/sidorares/dbus-native/issues/276)

Ship a hand-written `index.d.ts` in the package (not DefinitelyTyped, so it
cannot drift). This is table stakes in 2026 and is likely the biggest single
driver of users choosing `dbus-next`. Do it _after_ 2.1 so the promise-returning
signatures are typed correctly the first time.

### 2.4 Call timeouts and connection-death handling

**Issues:** [#137](https://github.com/sidorares/dbus-native/issues/137),
[#20](https://github.com/sidorares/dbus-native/issues/20),
**PR:** [#213](https://github.com/sidorares/dbus-native/pull/213)

Today a pending call whose reply never arrives leaks its entry in `bus.cookies`
forever, and if the connection dies every in-flight callback is silently
dropped. PR [#213](https://github.com/sidorares/dbus-native/pull/213) fixes the
second half — on `end`/`error`, fail every pending cookie. Add to that a
per-call and per-client `timeout` option that rejects with a
`org.freedesktop.DBus.Error.NoReply`-shaped error.

This is a correctness issue, not a nicety: long-lived daemons using this library
grow unboundedly today.

---

## 3. Medium priority

### 3.1 Variant handling

**PR:** [#143](https://github.com/sidorares/dbus-native/pull/143) (mvduin, with tests)

Variants currently unmarshal as `[signatureTree, [value]]` — the parsed tree
leaks the internal representation into the public API, and every caller writes
`result[1][0]`. Review #143, and consider making variants return the plain value
with the signature available separately, behind an opt-in option first.

Related: [#3](https://github.com/sidorares/dbus-native/issues/3),
[#132](https://github.com/sidorares/dbus-native/issues/132),
[#147](https://github.com/sidorares/dbus-native/issues/147),
[#67](https://github.com/sidorares/dbus-native/issues/67) — all variations on
"how do I deal with `a{sv}`". A documented, ergonomic dict/variant story would
close roughly a dozen issues at once.

### 3.2 Marshall JS objects as `a{sv}`

There is a `// TODO: serialise JS objects as a{sv}` in `lib/marshall.js` and a
disabled test (`test/js-types.js`) waiting for it. Combined with 3.1 this is the
"just let me pass a plain object" story users keep asking for.

### 3.3 High-level client/service API

**PR:** [#251](https://github.com/sidorares/dbus-native/pull/251) (acrisci)

Ports the `dbus-next` high-level interfaces on top of the existing low-level
ones. The PR is from 2018 and will not apply cleanly, but the design is proven
and it is additive by construction. Worth rebasing rather than redesigning —
and it is the most credible path to reconciling the two projects.

### 3.4 Properties: signals and access control

**Issues:** [#81](https://github.com/sidorares/dbus-native/issues/81),
[#89](https://github.com/sidorares/dbus-native/issues/89),
[#75](https://github.com/sidorares/dbus-native/issues/75),
[#91](https://github.com/sidorares/dbus-native/issues/91),
[#236](https://github.com/sidorares/dbus-native/issues/236),
[#117](https://github.com/sidorares/dbus-native/issues/117)

`Properties.Set` now actually writes the value, but:

- `PropertiesChanged` is never emitted when a property changes.
- Interface descriptors have no way to declare `read`/`write`/`readwrite`;
  `interfaceToXML` hardcodes `access="readwrite"`.
- `GetAll` on an interface with no properties still misbehaves
  ([#102](https://github.com/sidorares/dbus-native/issues/102)).

### 3.5 Finish the server/broker

`lib/server.js` plus `lib/server-handshake.js` are a stub: the handshake replies
with a hardcoded cookie and GUID copied from someone's 2014 session, and logs to
stdout unconditionally. Either finish it into a usable in-process broker — which
would give the test suite a dependency-free bus and let contributors run tests
without installing `dbus-daemon` — or mark it clearly experimental.

Note the `test/integration/` suite added in this pass already gives us real
coverage against `dbus-daemon`, so this is now an ergonomics win rather than a
blocker.

---

## 4. Lower priority / opportunistic

- **`launchd:` address family** ([#95](https://github.com/sidorares/dbus-native/issues/95))
  — how macOS actually advertises its session bus. Now that macOS is a
  first-class CI target this is cheap to add and makes `sessionBus()` work
  out of the box on a Mac.
- **Activatable service lookup** ([#133](https://github.com/sidorares/dbus-native/issues/133))
  — `StartServiceByName` exists but the new API never consults it.
- **`dbus-send` equivalent** ([#56](https://github.com/sidorares/dbus-native/issues/56))
  — a small CLI on top of the library; good first issue.
- **Introspect signals** — `lib/introspect.js` has `// TODO: introspect signals`,
  so proxies expose methods and properties but signals must be wired by hand.
- **Double serial increment** — `exportInterface`'s patched `emit()` does
  `self.serial++` a second time after sending, burning a serial number per
  signal. Harmless but wrong; related to
  [#126](https://github.com/sidorares/dbus-native/issues/126).
- **`lib/address-x11.js`** requires `x11`, which is not a dependency, so
  requiring it throws. Either make it a documented optional extra (done: it now
  says so) or move it out of the published `lib/`.
- **Drop `hexy`** — only used by two debug scripts (`bin/dbus-dissect.js`,
  `lib/portforward.js`). A 20-line hexdump helper would take the runtime
  dependency count to two.

### Issue-tracker hygiene

Roughly a third of the open issues are dead Greenkeeper bots
([#255](https://github.com/sidorares/dbus-native/issues/255)–[#273](https://github.com/sidorares/dbus-native/issues/273))
and superseded Dependabot PRs. Closing those in bulk would take the tracker from
65 open issues to something a new contributor can actually read. Several
question-style issues ([#88](https://github.com/sidorares/dbus-native/issues/88),
[#114](https://github.com/sidorares/dbus-native/issues/114),
[#132](https://github.com/sidorares/dbus-native/issues/132), …) are really
documentation gaps and should be converted into README sections and closed.

---

## 5. Toward 1.0

A plausible 1.0 is: promises by default, BigInt for 64-bit types, shipped
TypeScript types, call timeouts, and a variant/dict API that does not leak the
parser's tree. That is a coherent breaking change worth a major version, and it
would make this the obvious choice again for anyone currently picking between
three half-maintained packages.
