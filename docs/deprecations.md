# Deprecations

Stable codes for behaviour that changes in a future major release, so you can
migrate before it does. See [RELEASE_PLAN.md](../RELEASE_PLAN.md) for the
schedule.

Codes marked **runtime** emit a `DeprecationWarning` once per process. To find
every affected call site in your own codebase, turn them into thrown errors and
run your tests:

```sh
node --throw-deprecation --test          # node:test
node --throw-deprecation node_modules/.bin/<your-runner>
```

Codes marked **documentation** describe a shape change rather than an API call.
They are deliberately _not_ runtime warnings — the warning would have to fire
inside the parser when the value is read, so the stack trace would point at
this library rather than at the line in your code that unpacks the value. It
would tell you that you are affected without telling you where.

Finding those call sites is the linter's job:

```sh
npx dbus-native lint src/
```

```
src/net.js:42  DBUS_DEP0002  variant index chain `[1][1][0]`
    -> variantValue(), or a plain property read after 2.0
```

It reports and never rewrites, because reading a variant is an index chain and
nothing in the source says what the value is — see
[DBUS_DEP0002](#dbus_dep0002). It exits non-zero when there are findings, so it
can gate CI; `--exit-zero` reports without failing, and `--rule` selects
individual codes.

---

## DBUS_DEP0001

**Runtime.** The `ReturnLongjs` option is deprecated.

64-bit values (`x` and `t`) currently come back as lossy `number`, or as
[long.js](https://github.com/dcodeIO/long.js) objects with `ReturnLongjs: true`.
In **2.0** they become native `BigInt`, which represents the full 64-bit range
with no dependency and no option.

**You can have that now**, on a released version, with `returnBigInt: true` —
the same values 2.0 returns by default, so a call site migrated today needs no
change then:

```js
// deprecated
const bus = dbus.sessionBus({ ReturnLongjs: true });
const size = value.toNumber(); // lossy above 2^53

// available now, and the default in 2.0
const bus = dbus.sessionBus({ returnBigInt: true });
const size = await disk.Size(); // 2000398934016n
```

`returnBigInt` wins if both options are set, and writing a `bigint` is accepted
whatever the read option — so a service and its clients can move separately.
Note a service reads its _arguments_ through the same parser, so it needs the
option too if it handles large 64-bit inputs.

`BigInt` is not a drop-in for `number`: `size + 1` and `JSON.stringify({ size })`
both throw. That is the whole reason this is opt-in for a release before it
becomes the default — the failure mode is a `TypeError` in production rather
than a subtly wrong value, so it is better found deliberately than on upgrade
day.

---

## DBUS_DEP0002

**Documentation.** Reading a variant as `[signature, [value]]`.

A variant currently unmarshals to a two-element array of the _parsed signature
tree_ and a one-element array holding the value. In **2.0** it unmarshals to the
value itself.

```js
// today, and the source of more issues than anything else in this project
const udi = dict.find(([key]) => key === 'Udi')[1][1][0];

// forward-compatible: identical behaviour before and after 2.0
import { variantValue } from 'dbus-native';
const udi = variantValue(dict.find(([key]) => key === 'Udi')[1]);

// 2.0
const { Udi } = await device.props.$all;
```

`variantValue()` returns the value from either shape, so you can migrate now.
`variantSignature()` gets the signature if you need the type information that
the flattened form drops.

Related: [#3](https://github.com/sidorares/dbus-native/issues/3),
[#67](https://github.com/sidorares/dbus-native/issues/67),
[#132](https://github.com/sidorares/dbus-native/issues/132),
[#147](https://github.com/sidorares/dbus-native/issues/147).

---

## DBUS_DEP0003

**Documentation.** Reading a dict as an array of pairs.

`a{sv}` and friends currently unmarshal to an array of `[key, value]` pairs. In
**2.0** they unmarshal to a plain object.

```js
// today
const props = {};
for (const [key, variant] of result) props[key] = variant[1][0];

// forward-compatible
import { toPlain } from 'dbus-native';
const props = toPlain(result);

// 2.0
const props = result;
```

`toPlain()` recursively converts dicts to objects and unwraps variants, and is
a no-op on values that are already plain.

It only converts arrays this library tagged as dicts while parsing, so `a(ss)`
(an array of two-string structs) is left alone. A shape-based heuristic cannot
tell those two apart, which is why the parser tags them instead of guessing.

---

## DBUS_DEP0004

**Documentation. Completed in 0.7.** Errors delivered as arrays.

Before 0.7 a failed call passed the raw message body — an array of strings, or
`[]` when the body is empty — where a callback expects an `Error`. Since
**0.7** it is a `DBusError` with `message`, `dbusName` and a stack.

From 0.6 that array _also_ carried those properties, so code written this way
needed no change when 0.7 landed:

```js
bus.invoke(msg, err => {
  if (err?.dbusName === 'org.freedesktop.DBus.Error.ServiceUnknown') {
    // ...
  }
});
```

Reading `err[0]` worked until 0.7. Use `err.message`, or `err.body[0]` for an
error that really does carry several arguments.

Migration: [docs/migrating-to-0.7.md](./migrating-to-0.7.md). The pre-0.7 shape is
reconstructable with `toClassicError()` from `dbus-native/compat`.

Closed: [#39](https://github.com/sidorares/dbus-native/issues/39),
[#178](https://github.com/sidorares/dbus-native/issues/178),
[#207](https://github.com/sidorares/dbus-native/issues/207),
[#208](https://github.com/sidorares/dbus-native/issues/208).

---

## DBUS_DEP0005

**Runtime.** The `dbus2js` command is deprecated.

It emits untyped ES5, does not generate properties at all, and gives generated
signal handlers a match rule that asks the daemon for every signal of that name
from every service on the bus. Until 0.7 it also printed parsed property
objects into the middle of its own output, so redirecting it to a file produced
something that was not valid JavaScript.

`dbus-native types` replaces it, emitting TypeScript declarations that cover
methods, properties and signals:

```sh
# before
dbus2js --service org.example --path /org/example > client.js

# after
npx dbus-native types --service org.example --path /org/example --out types.d.ts
```

```ts
import type { OrgExampleIface } from './types';

const iface = await bus
  .getService('org.example')
  .getInterface<OrgExampleIface>('/org/example', 'org.example.Iface');
```

`dbus2js` still works and its remaining bugs have been fixed, since it is a
published binary and removing it outright would break build scripts. It will go
in a future major.
