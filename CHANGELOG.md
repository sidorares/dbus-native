# Changelog

## [0.11.0](https://github.com/sidorares/dbus-native/compare/v0.10.0...v0.11.0) (2026-07-29)


### ⚠ BREAKING CHANGES

Three things that worked in 0.10 behave differently. All three are cases the
library previously accepted and should not have; none affects code that was
already correct.

* **`exportInterface()` now rejects names that break the D-Bus naming rules**
  ([#333](https://github.com/sidorares/dbus-native/pull/333)) — the object
  path, `iface.name`, and every method, signal and property name. It throws at
  export rather than putting an unroutable message on the wire.

  **The case most likely to affect you is a property name containing `-` or
  `.`**, because those genuinely worked: a property name travels as a string
  *argument* to `Properties.Get`/`Set`, not in the message header, so
  `properties: { 'my-prop': 's' }` could be read and written quite happily.
  It now throws. Hyphens are the GObject convention, so services bridging
  GObject properties are the ones to check.

  A method or signal name with a hyphen also throws, but those were already
  broken for remote callers — the name goes in the header, where the rules are
  enforced by the bus.

  ```
  Invalid member name for properties.my-prop: "my-prop" -- must be a single
  element of [A-Za-z_][A-Za-z0-9_]* with no dots, at most 255 bytes
  ```

  Rename the member, or open an issue if you have a case where the old
  behaviour was correct. See [docs/api.md#names](https://github.com/sidorares/dbus-native/blob/master/docs/api.md#names).

* **`lib/portforward.js` has been removed**
  ([#342](https://github.com/sidorares/dbus-native/pull/342)) — it was
  reachable as `require('dbus-native/lib/portforward')`. Use
  `bin/dbus-dissect.js`, which forwards the same way on the same default port
  and prints decoded messages rather than a hexdump. This is what let the
  `hexy` dependency go.

* **A 64-bit field given something that is not a number now throws**
  ([#343](https://github.com/sidorares/dbus-native/pull/343)) —
  `marshall('x', [{}])`, `[[]]` and `[true]` used to write eight zero bytes
  with no complaint, because `Long.fromBits(undefined, undefined, undefined)`
  is zero. Passing a boolean where an integer belonged silently sent `0`.


### Features

* accept a plain JS object anywhere a dict is expected ([#335](https://github.com/sidorares/dbus-native/issues/335)) ([869a8df](https://github.com/sidorares/dbus-native/commit/869a8dfec08ae7bc1a192791fbde43921c58fdfd))
* read the 2.0 value shapes today with `plainValues` ([#340](https://github.com/sidorares/dbus-native/issues/340)) ([fcf00f6](https://github.com/sidorares/dbus-native/commit/fcf00f6545c91ffd19b790b9a2d7b3c4bb8f9cfc))
* say why UNIX_FD is unsupported, and scope what it would take ([#344](https://github.com/sidorares/dbus-native/issues/344)) ([2fa894b](https://github.com/sidorares/dbus-native/commit/2fa894be9ec3e7f1498c74203ae8f4adcf0aff9a))
* support launchd: addresses, so sessionBus() works on macOS ([#336](https://github.com/sidorares/dbus-native/issues/336)) ([24a4dbc](https://github.com/sidorares/dbus-native/commit/24a4dbc04abf1929fa5d653da60927fa983dbc26))
* validate names against the D-Bus rules before sending them ([#333](https://github.com/sidorares/dbus-native/issues/333)) ([1ac6c5e](https://github.com/sidorares/dbus-native/commit/1ac6c5e4ec9b1be93a30629003a8e4527b798778))


### Bug Fixes

* do not crash when a match call loses the race with a closing connection ([#339](https://github.com/sidorares/dbus-native/issues/339)) ([b0ad5b3](https://github.com/sidorares/dbus-native/commit/b0ad5b315c01d05a98207cf967a1fbfac2eb4237))
* let a service method return several out arguments ([#341](https://github.com/sidorares/dbus-native/issues/341)) ([3c5eec0](https://github.com/sidorares/dbus-native/commit/3c5eec0297951120217730c3f025f1a8a8fb3f2c))
* wrap the message serial instead of overflowing uint32 ([#337](https://github.com/sidorares/dbus-native/issues/337)) ([084aede](https://github.com/sidorares/dbus-native/commit/084aede42a7302a60e8ce305c2b0b5b94ae028e1))


### Documentation

* correct the ReturnLongjs deprecation status in ROADMAP 3.2 ([#345](https://github.com/sidorares/dbus-native/issues/345)) ([8bd9ab2](https://github.com/sidorares/dbus-native/commit/8bd9ab2e5a655871ef5b70146b0c963a008e209b))


### Code Refactoring

* make the library's own reads survive the 2.0 value shapes ([#338](https://github.com/sidorares/dbus-native/issues/338)) ([b2a9100](https://github.com/sidorares/dbus-native/commit/b2a9100241fcf7b2f8f249b8e36caa6716f00222))
* use bigint internally for x/t, confining Long.js to one option ([#343](https://github.com/sidorares/dbus-native/issues/343)) ([f68e575](https://github.com/sidorares/dbus-native/commit/f68e575d50a9e45d5bc310af641160a8f0c4de7a))

## [0.10.0](https://github.com/sidorares/dbus-native/compare/v0.9.0...v0.10.0) (2026-07-29)


### Features

* introspect signals, and fix proxy signal subscriptions ([#331](https://github.com/sidorares/dbus-native/issues/331)) ([eb23d94](https://github.com/sidorares/dbus-native/commit/eb23d945982fc8bb2af25f0a3fe569e4c6a3a88f))

## [0.9.0](https://github.com/sidorares/dbus-native/compare/v0.8.0...v0.9.0) (2026-07-29)


### Features

* emit PropertiesChanged, and honour declared property access ([#330](https://github.com/sidorares/dbus-native/issues/330)) ([3a54caa](https://github.com/sidorares/dbus-native/commit/3a54caa170c09662e9fea6071008aee2bea0fa02))
* opt-in BigInt for the 64-bit types ([#327](https://github.com/sidorares/dbus-native/issues/327)) ([48484a3](https://github.com/sidorares/dbus-native/commit/48484a3529510ff1340545003e394a446a4331bc))


### Bug Fixes

* do not write to a connection closed during the handshake ([#329](https://github.com/sidorares/dbus-native/issues/329)) ([2ab62fd](https://github.com/sidorares/dbus-native/commit/2ab62fd3d7587422cd5644c70a9202afdac3ed5a))

## [0.8.0](https://github.com/sidorares/dbus-native/compare/v0.7.0...v0.8.0) (2026-07-29)


### Features

* add `dbus-native lint` for the value shapes that change in 2.0 ([#325](https://github.com/sidorares/dbus-native/issues/325)) ([443cd37](https://github.com/sidorares/dbus-native/commit/443cd3790bc328f05aba7abec6dd392f4633c569))

## [0.7.0](https://github.com/sidorares/dbus-native/compare/v0.6.0...v0.7.0) (2026-07-29)


### ⚠ BREAKING CHANGES

* a failed call delivers a DBusError to callbacks rather than the message body array. Read err.message instead of err[0], and err.body for an error that really does carry several arguments. See docs/migrating-to-0.7.md.

### Features

* errors are Error objects (0.7) ([#323](https://github.com/sidorares/dbus-native/issues/323)) ([8e0e3af](https://github.com/sidorares/dbus-native/commit/8e0e3af03bca81344415e2201dbbc6eb2321f499))


### Bug Fixes

* export the error classes from index.js ([#322](https://github.com/sidorares/dbus-native/issues/322)) ([665f8f5](https://github.com/sidorares/dbus-native/commit/665f8f544de6bf9947312e6df2f6794a1e0b646d))

## [0.6.0](https://github.com/sidorares/dbus-native/compare/v0.5.0...v0.6.0) (2026-07-29)


### Features

* dbus-native types CLI, and deprecate dbus2js ([#321](https://github.com/sidorares/dbus-native/issues/321)) ([913d1d1](https://github.com/sidorares/dbus-native/commit/913d1d183b61e09c7bc337c90bd03afd1fd6a70a))
* forward-compatible value helpers and deprecation infrastructure ([2622dca](https://github.com/sidorares/dbus-native/commit/2622dcad7c9c5be62a61ee34e7eeee2dce5a6572))
* forward-compatible value helpers and deprecation infrastructure ([12fdd75](https://github.com/sidorares/dbus-native/commit/12fdd751e5c49c587e1a086afb7afd8a627ddf47))
* per-call and per-client timeouts, and AbortSignal support ([#318](https://github.com/sidorares/dbus-native/issues/318)) ([be1fefe](https://github.com/sidorares/dbus-native/commit/be1fefed27f7d75abb4b6d3a5ac1d91fa232a308))
* publish message and call traffic on diagnostics_channel ([#319](https://github.com/sidorares/dbus-native/issues/319)) ([1edf1e9](https://github.com/sidorares/dbus-native/commit/1edf1e92c73ce2db00aa913cae8de0db5ed8effa))
* return promises when no callback is given ([209dcde](https://github.com/sidorares/dbus-native/commit/209dcde96d12ca1037f088274af353eccab3f8bc))
* return promises when no callback is given ([d261d53](https://github.com/sidorares/dbus-native/commit/d261d53259de5d62b23a8c904606ef90d401cca5))
* ship TypeScript definitions ([#320](https://github.com/sidorares/dbus-native/issues/320)) ([6b22272](https://github.com/sidorares/dbus-native/commit/6b22272f571242b09a4a0460cbb5d67abf92c213))


### Documentation

* add BIG_FUTURE_PLANS.md, a modern-DX design sketch ([9812caa](https://github.com/sidorares/dbus-native/commit/9812caad4def30d62c810f5570cbae8e3e5bd1a3))
* add RELEASE_PLAN.md and reconcile the design doc with it ([1fdffbf](https://github.com/sidorares/dbus-native/commit/1fdffbf28917b4147b05173383b6889244d0505f))
* modern-DX design sketch and a staged release plan ([ec0049b](https://github.com/sidorares/dbus-native/commit/ec0049b0a1ef7a8ddd32f8023e27c2e117be63ee))

## [0.5.0](https://github.com/sidorares/dbus-native/compare/v0.4.0...v0.5.0) (2026-07-28)


### ⚠ BREAKING CHANGES

* requires Node.js >= 20.8.0, and the optional abstract-socket dependency is gone. Abstract sockets are still supported on Linux, now via Node itself.

### Features

* read big-endian messages ([327d093](https://github.com/sidorares/dbus-native/commit/327d09377d586a9bc1f8933d2dff5f402de1dc54))
* read big-endian messages ([358c52f](https://github.com/sidorares/dbus-native/commit/358c52f2c03eb92ee07eb21106ddaf3841abf3fe))
* respect write backpressure and batch writes within a tick ([56696e6](https://github.com/sidorares/dbus-native/commit/56696e644c5743b048ab34fe2cb951ac8ed34be6))
* respect write backpressure and batch writes within a tick ([3b0f1db](https://github.com/sidorares/dbus-native/commit/3b0f1db7b34d7923be379efa0863d7fae8aefc50))


### Bug Fixes

* copy ay byte arrays instead of returning a view of the message ([824e309](https://github.com/sidorares/dbus-native/commit/824e309ab5cad1320d388649d5d8a89c25d4ecb6))
* copy ay byte arrays instead of returning a view of the message ([b01bf52](https://github.com/sidorares/dbus-native/commit/b01bf520799a5de891a400cf1d4701d4f196e1bb))
* correct property writes, machine id, auth fallback and error names ([23eda5c](https://github.com/sidorares/dbus-native/commit/23eda5ceff01cd2bc6dd49dfceae5a16506b7354))
* harden the message read loop against malformed input ([00c7bf5](https://github.com/sidorares/dbus-native/commit/00c7bf59b765f956bcc55f6b41d076a1ce8c46c3))
* harden the message read loop against malformed input ([0b46789](https://github.com/sidorares/dbus-native/commit/0b46789dc5135179374a435b373e6fc148dba170))
* isolate message listeners from the read loop ([077a66f](https://github.com/sidorares/dbus-native/commit/077a66f74960d01428cf1c50fe12e191ebb784f9))
* isolate message listeners from the read loop ([5aae603](https://github.com/sidorares/dbus-native/commit/5aae6039d48400d28fd6a583b4a0fda8e64541d5))


### Performance Improvements

* cache parsed signatures ([ea233e3](https://github.com/sidorares/dbus-native/commit/ea233e3b3a17e139e53165c8a86ea6aad58300ad))
* cache parsed signatures ([21e8400](https://github.com/sidorares/dbus-native/commit/21e84001bc88070884780d26c6145aea15a02bd7))
* rewrite the marshaller onto a single-buffer cursor writer ([40016e6](https://github.com/sidorares/dbus-native/commit/40016e6f4545e7b6e105edecd170391b90d4a51f))
* rewrite the marshaller onto a single-buffer cursor writer ([04c6576](https://github.com/sidorares/dbus-native/commit/04c65762afa4ae03af3f210903041f66fd39ad8f))


### Dependencies

* cut runtime dependencies from seven to three ([9483096](https://github.com/sidorares/dbus-native/commit/94830964a778f167f205d95cb8cbea079ce2b54a))


### Documentation

* add ROADMAP and AGENTS guides, refresh README ([9d80c17](https://github.com/sidorares/dbus-native/commit/9d80c17865f1b62997d782351aa1884b18ac6b29))
* fold the wire-layer audit into ROADMAP as PR-sized blocks ([6fcc0cf](https://github.com/sidorares/dbus-native/commit/6fcc0cfcd59ddbcd909594e1aca5bb4f5a11e903))
* fold the wire-layer audit into ROADMAP as PR-sized blocks ([7640ab5](https://github.com/sidorares/dbus-native/commit/7640ab529e95eeb9e64c3a3d2400fe586d88a435))


### Code Refactoring

* modernise source to const/let and arrow functions ([7eff854](https://github.com/sidorares/dbus-native/commit/7eff8541e8ea1971bbee3b41663579e18838fdcc))
