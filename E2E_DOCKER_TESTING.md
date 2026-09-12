# End-to-end testing against a real desktop bus

A Linux container running actual desktop D-Bus services, for exercising
`dbus-native` against software nobody here wrote.

**This is not part of CI.** `npm test` and `npm run test:integration` stay as
they are — unit tests, and integration tests against a private `dbus-daemon`
we start ourselves. This is a checkpoint you run deliberately, when you want to
know whether the library still behaves against NetworkManager, UPower, GDBus,
sd-bus and python-dbus rather than against a bus shaped like our expectations.

```bash
e2e/run.sh                 # everything
e2e/run.sh 02-types.js     # one file
e2e/run.sh --shell         # a prompt inside, both buses already up
```

Requires Docker. The first build takes a few minutes; after that a full run is
about 40 seconds, most of it the 1.8s signal test and the container boot.

---

## Why this exists

The unit suite and the `test/integration/` suite both talk to a bus we
configured, exchanging values we chose. That leaves two blind spots:

1. **We pick the types.** Every signature in the test suite is one somebody
   here thought to write down. Real services emit `a(ss(sa{sv})tt)` and
   `a(ayuayu)` without being asked.
2. **We are both ends.** A test where dbus-native talks to dbus-native cannot
   tell you that GDBus can parse our introspection XML, that sd-bus can write
   our properties, or that python-dbus can read a hyphenated property name.

The container closes both. It is also the only place the _server_-facing
behaviour gets a real audience.

---

## What is in the container

`node:24-bookworm` plus the desktop stack. `e2e/docker/start-services.sh`
brings up a system bus, a session bus, an X server, and every service that will
run without hardware; anything that will not start is reported and skipped.

| bus     | services that come up                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------- |
| system  | `DBus`, `UPower`, `Accounts`, `Avahi`, `NetworkManager`, `UDisks2`, `PolicyKit1`                     |
| session | `DBus`, `Notifications` (dunst), `portal.Desktop`, `portal.Documents`, `impl.portal.PermissionStore` |

Also present as clients: `gdbus` (GLib), `busctl` (systemd/sd-bus),
`python3-dbus`, `dbus-send`, `dbus-monitor`.

`systemd1`, `login1`, `hostname1`, `locale1` and `timedate1` appear in
`ListActivatableNames` but do not start — there is no systemd as PID 1. The
tests that want them skip rather than fail.

---

## What it covers

`e2e/tests/`, run in order by `run.js`. 41 checks.

### `01-bus.js` — connecting, naming, walking

- Connect to the system bus and the session bus; confirm they are different buses
- `Hello` and the unique name; `GetId`
- `ListNames`, `ListActivatableNames`, `NameHasOwner`, `GetNameOwner`,
  `GetConnectionUnixProcessID`
- Introspect real services and **walk their whole object tree**, checking that
  every child a parent advertises is itself reachable
- `getInterface` / `getObject` / `as()` against a service we did not write
- A **container path** — one that implements nothing and only holds children —
  is reported as itself, with its children listed

Real trees walked: UPower (3 objects, one container), NetworkManager (46
objects, 6 levels deep), UDisks2, Accounts.

### `02-types.js` — the type system, against types we did not choose

The centrepiece is a catalogue: introspect everything on both buses, collect
every distinct signature, and **assert that all of them parse**. This run found
38, covering type codes `a b d h i o q s t u v x y`:

```
a(ssssssuuua{ss})   <- org.freedesktop.PolicyKit1.Authority.EnumerateActions
a(ss(sa{sv})tt)     <- org.freedesktop.PolicyKit1.Authority.EnumerateTemporaryAuthorizations
a{oa{sa{sv}}}       <- org.freedesktop.DBus.ObjectManager.GetManagedObjects
a(xxa{sv})          <- org.freedesktop.Accounts.User.LoginHistory
a(ayuayu)           <- org.freedesktop.NetworkManager.IP6Config.Routes
a{sas}              <- org.freedesktop.DBus.Debug.Stats.GetAllMatchRules
h                   <- org.freedesktop.UDisks2.Manager.LoopSetup
```

Then, reading real values:

- `a{sv}` from `UPower.GetAll`, in the classic shape and again under
  `plainValues`, and through `toPlain()`
- `variantValue` / `variantSignature` against a real variant, in both shapes
- A real 64-bit property (`NetworkManager.Device.Statistics.TxBytes`) as a
  `number` and as a `bigint` under `returnBigInt`, checking they agree
- **`a{oa{sa{sv}}}`** — `ObjectManager.GetManagedObjects` from NetworkManager,
  42 managed objects. This is the deepest nesting in common use
- `ao` as object paths, `ay`, `Peer.GetMachineId`
- **UNIX_FD**: calls `UDisks2.Manager.LoopSetup`, which really does take an
  `h`, and checks the refusal explains itself

### `03-signals-errors.js` — signals, match rules, failure

- `NameOwnerChanged` observed as a name is claimed and released
- An `arg0=` match rule
- `PropertiesChanged` from a real service (skips if none volunteers)
- Error names from real peers: `ServiceUnknown`, `UnknownMethod`,
  `UnknownProperty`, unknown object path
- The caller stack stitched onto a rejection (`--- d-bus call made at ---`)
- A per-call `timeout`, and cancellation through `AbortSignal`

### `04-interop.js` — our service, consumed by everyone else

Exports a service with methods (`s`, `uu`, `as`, `a{sv}` out), properties
(readwrite, read-only, and a hyphenated one), a signal, and two child objects.
Then, from outside:

| client            | checked                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| `gdbus`           | introspect, call, read `a{sv}`, receive signals via `gdbus monitor`, error reporting |
| `busctl` (sd-bus) | introspect, `tree`, call, get/set property, refusal on a read-only property          |
| `python3-dbus`    | call, `Properties.Get`, `GetAll`                                                     |
| dbus-native       | the same service through our own proxy API, for symmetry                             |

Every external command runs **async** — `execFileSync` would block the event
loop and our own service would never answer. That is worth remembering if you
add to this file.

---

## What this run validated

The tree under test had the six fixes merged after 0.11.0 (#346, #347, #348,
#350, #351, #352). Several of them are visible here in a way no unit test can
show:

- **#346** — python-dbus reads `my-prop` and lists it in `GetAll`; sd-bus shows
  `.my-prop property s "hyphens work"`.
- **#347** — GDBus parses our introspection XML with an argument named
  `fields & more` in it. Unescaped, the `&` would have made the whole document
  unparseable and GDBus would have reported no interfaces at all.
- **#350** — `/org/freedesktop/UPower/devices` comes back as _itself_, with
  `nodes: ["DisplayDevice"]`. Before, it came back as `DisplayDevice`.
- **#351** — `busctl tree com.example.E2EService` draws the children:

  ```
  └─/com/example/E2EService
    ├─/com/example/E2EService/Alpha
    └─/com/example/E2EService/Beta
  ```

  sd-bus can only draw that because our `Introspect` now lists them.

---

## Findings

Things this turned up that are not bugs the tests fix, recorded so they are not
rediscovered:

1. **A marshalling failure is raised synchronously from `invoke()`**, not
   delivered as a rejection or to the callback. `await bus.invoke(...)` inside
   a `try` sees it, but `bus.invoke(...).catch(...)` does not, and the callback
   form gets a throw where it expects `cb(err)`. Everything else since 0.7
   delivers failures as a `DBusError`. Pinned by the UNIX_FD test in
   `02-types.js` so a change in either direction is deliberate.

2. **The system bus refuses arbitrary well-known names**, as it should:
   `Connection ":1.11" is not allowed to own the service "com.example.E2EQuiet"
due to security policies in the configuration file`. Tests that need to own
   a name must use the session bus.

3. **Introspecting every name is expensive** if a service exports one object
   per unit. `02-types.js` caps the walk; without it, systemd-shaped services
   turn a catalogue into thousands of round trips.

4. **Activatable names block for the full bus timeout** when activation cannot
   succeed. Every connection here sets a 5s per-call `timeout` for that reason;
   without it a container full of unstartable services looks like a hang.

---

## What it cannot cover

- **UNIX_FD passing, on Node.** Refusing it is checked; carrying one is not
  possible there — see ROADMAP §2.8. Under Bun it is: `test/bun/` passes a
  descriptor between two clients through a real dbus-daemon, and that runs in
  CI on Linux and macOS.
- **Big-endian messages.** Every peer here is little-endian. The unit suite
  covers big-endian reads with fixtures.
- **systemd, logind, hostnamed.** They need PID 1. Running the container with
  `--privileged` and a systemd entrypoint would reach them, at the cost of a
  much slower and more fragile setup.
- **Real hardware.** UPower reports no batteries, UDisks2 no disks, so the
  device trees are shallow. What is exercised is the shape of the protocol, not
  the variety of the data.

---

## Adding to it

Files matching `NN-*.js` in `e2e/tests/` are picked up automatically by
`run.js`. `helpers.js` has the connection factories (both already carrying a
per-call timeout), `walk()` for tree traversal, and `eventually()` for waiting
on a signal.

Anything that depends on a particular service should ask `listNames()` first
and log a skip, the way `02-types.js` does for systemd. What starts inside a
container is not something to hardcode.
