# Deprecations

Stable codes for behaviour that changes in a future major release, so you can
migrate before it does. See [RELEASE_PLAN.md](../RELEASE_PLAN.md) for the
schedule.

Codes marked **runtime** emit a `DeprecationWarning` once per process. To find
every affected call site in your own codebase, turn them into thrown errors and
run your tests:

```sh
node --throw-deprecation node_modules/.bin/mocha
```

Codes marked **documentation** describe a shape change rather than an API call.
They are deliberately _not_ runtime warnings — the warning would have to fire
inside the parser when the value is read, so the stack trace would point at
this library rather than at the line in your code that unpacks the value. It
would tell you that you are affected without telling you where. A lint rule
that flags the access patterns is planned for that; until then the migration is
to route reads through the helpers below.

---

## DBUS_DEP0001

**Runtime.** The `ReturnLongjs` option is deprecated.

64-bit values (`x` and `t`) currently come back as lossy `number`, or as
[long.js](https://github.com/dcodeIO/long.js) objects with `ReturnLongjs: true`.
In **2.0** they become native `BigInt`, which represents the full 64-bit range
with no dependency and no option.

```js
// deprecated
const bus = dbus.sessionBus({ ReturnLongjs: true });
const size = value.toNumber();

// 2.0
const size = await disk.props.Size; // 2000398934016n
```

`BigInt` is not a drop-in for `number`: `size + 1` and `JSON.stringify({ size })`
both throw. Plan for that rather than discovering it in production — there will
be a dedicated migration guide.

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

**Documentation.** Errors delivered as arrays.

A failed call currently passes the raw message body — an array of strings, or
`[]` when the body is empty — where a callback expects an `Error`. In **1.0**
it becomes a `DBusError` with `message`, `dbusName` and a stack.

Since 0.6 that array _also_ carries those properties, so this works today and
continues to work in 1.0 unchanged:

```js
bus.invoke(msg, err => {
  if (err?.dbusName === 'org.freedesktop.DBus.Error.ServiceUnknown') {
    // ...
  }
});
```

Reading `err[0]` keeps working until 1.0. Use `err.message` instead.

Related: [#39](https://github.com/sidorares/dbus-native/issues/39),
[#178](https://github.com/sidorares/dbus-native/issues/178),
[#207](https://github.com/sidorares/dbus-native/issues/207),
[#208](https://github.com/sidorares/dbus-native/issues/208).
