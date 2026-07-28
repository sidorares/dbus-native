# Changelog

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
