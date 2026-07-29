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
   workaround — which §3.2 (BigInt) removes the need for entirely.
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

## 2. Wire layer: audit findings

The marshaller, unmarshaller and stream framing were audited on 2026-07-28
against commit `8373dcb`. Every claim below was measured or reproduced, not
inferred from reading; the numbers are from an M-series Mac on Node 26 and are
meant for relative comparison, not as absolutes.

Blocks are sized to be one PR each and are listed in the order they should
land. §2.1 is security-relevant and should go first; §2.2 is the largest win
and is independent of it.

### 2.1 Harden the read loop against malformed input

**Severity: high — a hostile or buggy peer can crash the process.**

`lib/message.js` reads a 16-byte header, trusts the declared lengths, and calls
`onMessage()` from inside the `'readable'` handler with no error boundary.
Reproduced, each in a fresh process:

```
bad-header       exit=1  CRASHED: RangeError [ERR_OUT_OF_RANGE]: "size" ... <= 1GiB
handler-throws   exit=1  CRASHED: Error: handler blew up
truncated-tail   exit=0  survived (waiting for rest)
```

Work:

- **Enforce the spec limits.** The D-Bus spec caps a message at 128 MiB and an
  array at 64 MiB. Nothing enforces either, so a peer declaring a 900 MB body
  makes us buffer 900 MB, and anything over 1 GiB throws out of `stream.read()`.
  Reject oversized declarations with a protocol error and destroy the
  connection instead of trying to satisfy them.
- **Fix the int32 overflow at `message.js:25`.** `((fieldsLength + 7) >> 3) << 3`
  yields `-16` for `fieldsLength = 0xfffffff0` instead of 4294967280, so
  `fieldsAndBodyLength` can go negative. Use `Math.ceil(n / 8) * 8` or apply the
  size cap before the arithmetic.
- **Guard the no-body case in `message.unmarshall()`.** Line 73 calls
  `msgBuf.read(message.signature)` unconditionally, so _every_ argument-less
  message — `Hello`, `Ping`, `ListNames` — throws
  `TypeError: Cannot read properties of undefined`. The streaming path at line
  50 already guards correctly with `if (bodyLength > 0 && message.signature)`;
  make the two agree. This is exported API and is used by `bin/dbus-dissect.js`.
- **Make `readString` reject rather than truncate.** `buffer.toString('utf8',
pos, pos + len)` silently clamps to the buffer end, so a corrupt length field
  produces a short string and no error. Validate `pos + len` against the buffer
  and check the trailing NUL.
- **Give the parse loop an error boundary.** A throw currently escapes the
  `'readable'` handler and becomes an uncaught exception. Catch it, emit it on
  the connection as `'error'`, and stop parsing that connection.

### 2.2 Isolate user handlers from the read loop

**Severity: high — an ordinary application bug kills the process.**

Distinct from §2.1 and worth its own change: message dispatch runs synchronously
inside the read loop, so an exception in _user_ code unwinds through the parser.
Method-call handlers are safe because `lib/bus.js` wraps them in
`Promise.resolve().then()`, but signal delivery is a plain synchronous `emit`:

```
Error: bug inside a user signal handler
    at EventEmitter.emit (node:events:509:20)
    at EventEmitter.<anonymous> (lib/bus.js:144:20)     <- signals.emit
    at index.js:110:14
    at Socket.<anonymous> (lib/message.js:53:9)          <- readable handler
```

Dispatch should be isolated so a listener that throws surfaces as a connection
`'error'` (or an `uncaughtException`-style hook) without taking down the parser
or losing the rest of the read buffer. Care needed: this changes observable
behaviour for anyone currently relying on the crash, so it wants a note in the
changelog.

### 2.3 Rewrite the marshaller onto a single-buffer cursor writer — DONE

Landed in #307. Kept for the record; the measured result is at the bottom of
this section.

**Severity: high for throughput — up to 2000× on byte arrays.**

`lib/marshall.js` and `lib/put.js` allocate a fresh `Buffer` for every scalar
written, push it onto an array, and `Buffer.concat` at the end. Byte arrays are
walked element-by-element, so an `ay` costs one allocation _per byte_:
**1026 `Buffer.alloc` calls to marshal 1 KB**, and 28 for a small method call.

Measured against a prototype cursor writer (grow-on-demand buffer, strings
written via `buf.write()` + `Buffer.byteLength` with no intermediate, `ay`
fast-pathed to a single copy). The prototype produced **byte-identical output on
30/30 cases** including non-zero start offsets:

| case                          | shipped    | prototype |           |
| ----------------------------- | ---------- | --------- | --------- |
| Notify-like (`susssasa{sv}i`) | 4.92 µs    | 1.18 µs   | 4.2×      |
| single string (`s`)           | 0.41 µs    | 0.19 µs   | 2.2×      |
| `ai`, 10k ints                | 1226 µs    | 144 µs    | 8.5×      |
| `as`, 1k strings              | 374 µs     | 160 µs    | 2.3×      |
| `ay` from Buffer, 1 KB        | 105.6 µs   | 0.65 µs   | **162×**  |
| `ay` from Buffer, 64 KB       | 14 727 µs  | 10.1 µs   | **1456×** |
| `ay` from Buffer, 1 MB        | 293 204 µs | 141.7 µs  | **2069×** |

The `ay` case is the headline: **3.5 MB/s against an ~8 GB/s memcpy ceiling**.
Reading the same array takes 0.95 µs, so writing is ~300 000× slower than
reading for identical data. Anything moving images, audio or file contents over
D-Bus hits this.

Fold into the same PR, since they touch the same code:

- **Fast-path `ay`** when the value is a `Buffer`/`Uint8Array`: one length write
  plus one copy.
- **Memoise `MakeSimpleMarshaller`.** `marshall.js` constructs a fresh object
  with fresh closures for _every scalar written_; there are only 13 types.
  Worth ~8% on its own — small, but free once the file is open.
- **Keep the validation.** The prototype has none; the range and type checks in
  `marshallers.js` are load-bearing (`test/unmarshall-basic.js` asserts on them)
  and must be ported, not dropped.

This obsoletes `lib/put.js`, added in #299. That was the right minimal fix for
removing the abandoned `put` dependency, but it inherits that package's
allocation model.

**Outcome (#307).** `lib/writer.js` replaces `lib/put.js` and `lib/align.js`,
both deleted. Validated by a differential test against the previous
implementation: **1157/1157 byte-identical** across every type, at twelve
starting offsets each, plus error-message parity on the failure paths. Measured
on the same machine as the numbers above:

| case                           | before     | after   |           |
| ------------------------------ | ---------- | ------- | --------- |
| Notify-like (`susssasa{sv}i`)  | 5.41 µs    | 2.18 µs | 2.5×      |
| `message.marshall` (full call) | 10.71 µs   | 5.28 µs | 2.0×      |
| `ai`, 10k ints                 | 1226 µs    | 403 µs  | 3.0×      |
| `as`, 1k strings               | 374 µs     | 150 µs  | 2.5×      |
| `ay` from Buffer, 1 KB         | 105.6 µs   | 0.67 µs | **158×**  |
| `ay` from Buffer, 1 MB         | 293 204 µs | 127 µs  | **2300×** |

`ay` now runs at 1.5–8 GB/s rather than 3.5 MB/s. The gap to the unvalidated
prototype (2.18 µs vs 1.18 µs on the Notify case) is signature parsing, which
§2.4 addresses.

Sequence with §3.2 (BigInt): both rewrite the same scalar paths. Either do
BigInt first and rewrite once, or accept touching `x`/`t` twice.

### 2.4 Cache parsed signatures — DONE

Landed in #308.

**Severity: medium — pure win, small diff.**

`parseSignature` is called from `readVariant` for **every variant value**, so
unmarshalling an `a{sv}` with 500 entries parses 500 signatures and costs
243.6 µs. On the write path it runs once per `marshall()` call plus once per
variant, and `'yyyyuua(yv)'` is re-parsed for every message.

Signatures come from a tiny set in practice. A bounded `Map` cache (capped, so a
peer sending unique signatures cannot grow it without limit) is a few lines.
Note the returned tree must then be treated as immutable — check no caller
mutates it before landing this.

**Outcome (#308).** Cached in `lib/signature.js`, capped at 1000 entries with
oldest-first eviction. No caller mutates a tree, but `DBusBuffer.readVariant`
_returns_ one to application code as `variant[0]`, so cached trees are
deep-frozen rather than merely documented as immutable.

| case                            | before   | after    |      |
| ------------------------------- | -------- | -------- | ---- |
| unmarshall `a{sv}`, 500 entries | 243.6 µs | 124.2 µs | 2.0× |
| unmarshall Notify-like          | 1.33 µs  | 1.03 µs  | 1.3× |
| marshall Notify-like            | 2.18 µs  | 1.86 µs  | 1.2× |
| `message.marshall` (full call)  | 5.28 µs  | 4.13 µs  | 1.3× |

This is the first item in §2 to speed up the **read** path, which §2.1–§2.3 left
untouched.

### 2.5 `ay` buffer views retain the whole message — DONE

Landed in #310.

**Severity: medium — unbounded memory growth in long-lived processes.**

`dbus-buffer.js:119` returns `this.buffer.slice(start, this.pos)`, a _view_
sharing memory with the whole message. Verified: a 4-byte `ay` pulled out of a
4 MB message keeps the entire 4 MB `ArrayBuffer` alive. Retain a few small byte
arrays from large messages and memory grows with traffic, not with data kept.

Also `Buffer.prototype.slice` is deprecated in favour of `subarray` (identical
semantics), so this line should change regardless.

Decide deliberately: copy by default (safe, costs a memcpy) or keep the view and
document it, ideally as an explicit `ayBuffer: 'view' | 'copy'` option. Copy is
the better default — the current behaviour is a footgun that only shows up under
load.

**Outcome (#310).** Copy by default; `ayBuffer: 'view'` opts back into the
zero-copy view, and `ayBuffer: false` still yields a plain array. `slice` also
became `subarray`.

The copy runs at 5–8.5 GB/s, so it costs 0.18 µs on a 1 KB `ay` and 117 µs on a
1 MB one. That is real, but small next to the socket read that delivered the
message, and it is the difference between a 4 byte value retaining 4 bytes and
retaining 4 MB. Throughput-sensitive callers that consume and drop the value
promptly can set `'view'`.

### 2.6 Accept big-endian messages — DONE

Landed in #311.

**Severity: low frequency, but a spec violation.**

`constants.endianness.be` is defined and never read. Byte 0 of the header — the
byte order flag — is never consulted, and every read is `readUInt32LE` /
`readInt32LE`. Flipping a message's flag to `'B'` changes nothing: the reader
ignores it and reads little-endian regardless.

The spec requires receivers to accept both byte orders; senders may keep
emitting little-endian. Only bites when talking to a big-endian peer (s390x,
some MIPS/PPC), which is why it has gone unnoticed.

Work: thread a byte-order flag through `DBusBuffer` and pick `*LE`/`*BE` readers
from it. Mostly mechanical, but it touches every read method, so it deserves its
own PR and a round-trip test against a hand-built big-endian fixture.

**Outcome (#311).** Byte order is read from header byte 0 and threaded into
`DBusBuffer`, which selects `*LE`/`*BE` accessors per read. The 64-bit types
needed care: both the bytes within each 32-bit word _and_ the order of the two
words flip. Anything that is neither `'l'` nor `'B'` is still a protocol error.

Senders still emit little-endian, which the spec permits. No measurable cost to
the read path (1.09 µs vs 1.03 µs on the Notify case, within run-to-run noise).

Fixtures are assembled by hand with Node's own `writeUInt32BE`, not by
round-tripping through this library, so a writer and reader sharing the same
mistake cannot make the tests pass. That caught a bug in the fixture itself:
`g` (signature) values take a one-byte length and no alignment, unlike `s`.

### 2.7 Backpressure on the write path — DONE

Landed in #313.

**Severity: medium for high-throughput senders.**

`index.js:126` and `:132` discard the return value of `stream.write()`, so a
producer faster than the socket grows Node's internal write buffer without
bound. There is no `cork`/`uncork` batching either, so emitting N signals in a
tick issues N separate writes.

Work: respect the `false` return, expose `'drain'` (or return a promise from
`connection.message()`), and consider corking within a tick.

**Outcome (#313).** `connection.message()` now returns the writable's boolean,
and the connection re-emits `'drain'` — the same contract as `stream.write()`,
so the idiom is the one Node users already know. Messages written in the same
tick are corked into a single flush: ten messages in one turn of the event loop
went from ten `_write` calls to one `_writev`.

Deliberately _not_ returning a promise from `message()`. §3.1 will make the
proxy layer promise-returning, and having the low-level method already resolve
to something unrelated would collide with it.

### 2.8 UNIX_FD (`h`) support

**Severity: feature gap — blocks whole categories of users.**

`signature.js` parses `h`, but both directions throw: `Unknown data type
format: h` and `Unsupported type: h`. There is no SCM_RIGHTS handling anywhere.
systemd, the XDG desktop portals and PipeWire all pass file descriptors, so
those APIs are simply unreachable from this library.

This is the largest item in this section and needs design first: Node has no
public SCM_RIGHTS API, so it likely means a small native addon or a
`child_process`-mediated hack — which would undo the "no native dependencies"
property this package is valued for. Worth scoping before committing.

### 2.9 Small non-canonical cleanups — DONE

Landed in #312.

**Severity: low — batch them into one tidy-up PR.**

- `DBusBuffer` **mutates the caller's options object**, adding `ayBuffer: true`
  to the connection opts you passed in.
- `new DBusBuffer(buf, 0, null)` throws, because `typeof null === 'object'`
  slips past the guard.
- `lib/unmarshall.js` returns `Buffer.from('')` for an empty signature where
  every other path returns an array.
- `marshallers.js` calls `parseInt`/`parseFloat` on values already validated as
  numbers.
- `lib/readline.js` reads **one byte at a time** via `stream.read(1)`.
  Handshake-only so the impact is negligible, but it is not idiomatic.
- `message.js` never validates the protocol version byte (`header[3]`).

**Outcome (#312).** All done, except `parseInt`/`parseFloat`, which the §2.3
rewrite had already removed. Two are behaviour changes worth noting in the
changelog: `unmarshall('')` now returns `[]` rather than an empty `Buffer`, and
a message declaring a protocol version other than 1 is rejected as the spec
requires instead of being parsed anyway.

`readOneLine` now reads whole chunks and `unshift()`s the remainder rather than
calling `stream.read(1)` per byte. It only runs during the SASL handshake, so
this is tidiness rather than throughput — but it is on the critical path, so it
gained its own test file alongside the existing real-daemon handshake coverage.

---

## 3. High priority

### 3.1 Promise support for method calls

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

### 3.2 Replace Long.js with BigInt

**Issue:** [#248](https://github.com/sidorares/dbus-native/issues/248),
**PR:** [#252](https://github.com/sidorares/dbus-native/pull/252)

`BigInt` is native and removes the last non-trivial runtime dependency — and
with it the ARMv6 `long.js` crash that forced the Homebridge fork to vendor
their own copy.

Plan: read `x`/`t` with `readBigInt64LE`/`readBigUInt64LE`; accept
`bigint`, `number`, `string` and `Long`-shaped objects on marshall. Gate the
return type behind an option (`ReturnBigInt`) for one minor release alongside
the existing `ReturnLongjs`, then flip the default in 0.7 and drop `long`.

### 3.3 TypeScript declarations

**Issue:** [#276](https://github.com/sidorares/dbus-native/issues/276)

Ship a hand-written `index.d.ts` in the package (not DefinitelyTyped, so it
cannot drift). This is table stakes in 2026 and is likely the biggest single
driver of users choosing `dbus-next`. Do it _after_ 2.1 so the promise-returning
signatures are typed correctly the first time.

### 3.4 Call timeouts and connection-death handling

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

**Both halves are now done.** The per-call and per-client `timeout` option, with
`AbortSignal` support, shipped in 0.6. Connection death fails every pending call
with a `ConnectionClosedError` as of 0.7, which absorbs #213 — see
[docs/migrating-to-0.7.md](./docs/migrating-to-0.7.md). What remains under this
heading is #20 and #137: `connection.end()` still throws
`ERR_STREAM_WRITE_AFTER_END` rather than flushing cleanly, and a _default_
timeout is deliberately held back to 3.0 because it makes previously-hanging
calls start failing.

---

## 4. Medium priority

### 4.1 Variant handling

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

### 4.2 Marshall JS objects as `a{sv}`

There is a `// TODO: serialise JS objects as a{sv}` in `lib/marshall.js` and a
disabled test (`test/js-types.js`) waiting for it. Combined with 3.1 this is the
"just let me pass a plain object" story users keep asking for.

### 4.3 High-level client/service API

**PR:** [#251](https://github.com/sidorares/dbus-native/pull/251) (acrisci)

Ports the `dbus-next` high-level interfaces on top of the existing low-level
ones. The PR is from 2018 and will not apply cleanly, but the design is proven
and it is additive by construction. Worth rebasing rather than redesigning —
and it is the most credible path to reconciling the two projects.

### 4.4 Properties: signals and access control

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

### 4.5 Finish the server/broker

`lib/server.js` plus `lib/server-handshake.js` are a stub: the handshake replies
with a hardcoded cookie and GUID copied from someone's 2014 session, and logs to
stdout unconditionally. Either finish it into a usable in-process broker — which
would give the test suite a dependency-free bus and let contributors run tests
without installing `dbus-daemon` — or mark it clearly experimental.

Note the `test/integration/` suite added in this pass already gives us real
coverage against `dbus-daemon`, so this is now an ergonomics win rather than a
blocker.

---

## 5. Lower priority / opportunistic

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

## 6. Toward 1.0

> **Superseded by [RELEASE_PLAN.md](./RELEASE_PLAN.md).** The single-big-major
> idea below was split into a series of narrow ones, each small enough to
> document and tool properly: 1.0 errors, 2.0 the type system, 3.0 lifecycle,
> 4.0 ESM. 0.6 shipped the additive preparation; 0.7 makes errors real `Error`s
> ([docs/migrating-to-0.7.md](./docs/migrating-to-0.7.md)). The paragraph below is
> kept because it is still an accurate description of the destination.

A plausible 1.0 is: promises by default, BigInt for 64-bit types, shipped
TypeScript types, call timeouts, and a variant/dict API that does not leak the
parser's tree. That is a coherent breaking change worth a major version, and it
would make this the obvious choice again for anyone currently picking between
three half-maintained packages.

Section 2 is mostly orthogonal to that: the read-loop hardening (§2.1, §2.2) and
the marshaller rewrite (§2.3) are behaviour-preserving for well-formed traffic
and should ship in patch and minor releases as they land, not wait for 1.0. Only
the `ay` copy semantics (§2.5) and any variant change (§4.1) need a major.
