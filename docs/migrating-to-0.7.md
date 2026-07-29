# Migrating to 0.7

**0.7 makes D-Bus errors real `Error` objects.** That is the whole release —
nothing else in the API changes.

[RELEASE_PLAN.md](../RELEASE_PLAN.md) calls this release "1.0". It ships as
0.7.0 instead: under semver a `0.x` minor is already the breaking bump, and
1.0.0 is a statement about stability that is worth making deliberately rather
than as a side effect of the first break in the series. Nothing about the
content changed; the rest of the plan's sequence still holds.

If you followed the `DBUS_DEP0004` guidance in 0.6 and read `err.message` and
`err.dbusName`, **you need no changes at all**. This guide is for everyone
else.

---

## What changed

| behaviour                   | 0.6 and earlier                        | 0.7                                                 |
| --------------------------- | -------------------------------------- | --------------------------------------------------- |
| callback error on a failure | the message body, an array             | a `DBusError`                                       |
| error with an empty body    | `[]`                                   | `DBusError` whose `message` is the D-Bus error name |
| `err instanceof Error`      | `false`                                | `true`                                              |
| the error's arguments       | `err[0]`, `err[1]`, …                  | `err.body[0]`, `err.body[1]`, …                     |
| `JSON.stringify(err)`       | `["something failed"]`                 | `{}` — as for any `Error`                           |
| missing interface           | `getInterface` → `(null, undefined)`   | rejects with `UnknownInterfaceError`                |
| `obj.as('not.an.iface')`    | `undefined`                            | throws `UnknownInterfaceError`                      |
| connection dies mid-call    | pending callbacks dropped, silently    | all fail with `ConnectionClosedError`               |
| call made after it died     | warning on stderr, callback never runs | fails with `ConnectionClosedError`                  |

The promise API is unaffected: it has rejected with a `DBusError` since 0.6,
when it was introduced. Timeouts (`TimeoutError`) and aborts (`AbortError`)
were already `Error`s in 0.6 and are unchanged.

Also fixed in passing: the error classes are now actually exported.
`index.d.ts` declared `DBusError`, `TimeoutError` and `AbortError` from 0.6,
but `index.js` never exported them, so `err instanceof DBusError` could not be
written at runtime.

---

## Updating your code

### Reading the message

```diff
  bus.invoke(msg, (err, result) => {
-   if (err) return reject(new Error(err[0]));
+   if (err) return reject(err);
  });
```

```diff
  bus.invoke(msg, (err, result) => {
-   if (err) console.error('call failed:', err[0]);
+   if (err) console.error('call failed:', err.message);
  });
```

### Switching on the error

Unchanged from 0.6 — this is what the forward-compatible properties were for:

```js
bus.invoke(msg, err => {
  if (err?.dbusName === 'org.freedesktop.DBus.Error.ServiceUnknown') {
    // ...
  }
});
```

### Reading the error's other arguments

Most D-Bus errors carry a single string, which is now `err.message`. If the
service sends more than one, the whole body is still there:

```diff
- const [text, code] = err;
+ const [text, code] = err.body;
```

### Logging

An `Error` does not serialise to JSON the way an array did. If you log
structured JSON, say what you want explicitly:

```diff
- logger.error({ err });
+ logger.error({ err: { message: err.message, dbusName: err.dbusName } });
```

Most logging libraries (pino, bunyan, winston) already special-case `Error`
instances and will do something more useful than they did with the array.

### Handling a dead connection

Previously a connection that dropped left every in-flight call hanging forever
— [#39](https://github.com/sidorares/dbus-native/issues/39). Those now fail, so
code that was silently stuck starts reporting:

```js
try {
  await iface.SlowCall();
} catch (err) {
  if (err.code === 'ECONNCLOSED') {
    // reconnect, retry, give up -- but at least you find out
  }
}
```

This is the one change that can make previously "working" (hanging) code start
throwing. That is the point of it, but it is worth grepping for calls whose
rejection you never handled.

---

## The codemod

For the mechanical part:

```sh
npx dbus-native codemod errors-to-error-objects src/
```

Add `--dry` to see the diff without writing anything. It applies every rewrite
above — `err[0]` → `err.message`, `err[n]` → `err.body[n]`,
`new Error(err[0])` → `err`, and array destructuring → `err.body`.

**It only rewrites callbacks it can prove are D-Bus callbacks** — a function
argument to `invoke`, `getInterface`, `addMatch`, `getId` and the rest of the
bus surface. Everything else it leaves alone and reports:

```
src/net.js:22  DBUS_DEP0004  err[0] on an error this codemod could not
                             attribute to a d-bus call -- review by hand
```

The big category there is proxy method calls — `iface.Echo('x', cb)` — where
the member name is the _remote_ method and could be anything. There is no
call-site shape to match on, so those are yours to check. A codemod that
guesses wrong in an error path is worse than one that does nothing.

It also respects shadowing: a nested `function (err) {…}` inside a D-Bus
callback has its own `err`, and that one is left alone.

jscodeshift is not a dependency of this package. If your project does not
already have it, the command runs it through `npx`.

---

## The escape hatch

If you cannot migrate a call site yet:

```js
const { toClassicError } = require('dbus-native/compat');

bus.invoke(msg, err => {
  const classic = toClassicError(err); // the pre-0.7 array, properties and all
});
```

Deliberately a subpath import rather than a client option. An option would be a
mode — invisible at the call site and inherited by code that never asked for
it. An import is greppable, obviously temporary, and deleting it is one line.

`toClassicError` only converts errors that came from an error _reply_. A
timeout, an abort or a closed connection never had an array form, so those are
returned unchanged.

---

## Issues this closes

[#39](https://github.com/sidorares/dbus-native/issues/39),
[#178](https://github.com/sidorares/dbus-native/issues/178),
[#207](https://github.com/sidorares/dbus-native/issues/207),
[#208](https://github.com/sidorares/dbus-native/issues/208), and
[PR #213](https://github.com/sidorares/dbus-native/pull/213).
