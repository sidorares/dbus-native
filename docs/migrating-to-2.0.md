# Migrating to 2.0

**2.0 changes the shapes values arrive in.** A variant becomes the value it
holds, a string-keyed dict becomes a plain object, and 64-bit integers become
`bigint`. Nothing else about the API moves.

It is the release people have been asking for since
[#3](https://github.com/sidorares/dbus-native/issues/3) in 2013, and it is the
one that breaks the most code, because these shapes are what every `invoke`
callback in your program reads.

**The whole of it can be done before you upgrade.** Every change below is
available today, per connection, behind an option. You can migrate one file at
a time on a released version, verify it against your real bus, and arrive at
2.0 with nothing left to do. Read [Doing it early](#doing-it-early) first if you
read nothing else.

---

## What changes

| D-Bus type       | 1.x                                | 2.0                 |
| ---------------- | ---------------------------------- | ------------------- |
| `v`              | `[parsedSignatureTree, [value]]`   | the value           |
| `a{sv}`, `a{ss}` | array of `[key, value]` pairs      | a plain object      |
| `x`, `t`         | lossy `number`, or long.js objects | **`bigint`**        |
| `ay`             | `Buffer`                           | `Buffer`, unchanged |

`ay` stays a `Buffer` deliberately. `Buffer` is a `Uint8Array` subclass, so
anything that accepts the latter already accepts the former, while
`buf.toString('utf8')` does not exist on a plain `Uint8Array`. Changing it
would cost real code and buy nothing in a Node-only library.

---

## `bigint` is the sharp edge

Take this one first. The other two changes make code that reads a value shape
fail loudly at the read. This one makes code fail somewhere else entirely,
often much later, in a line you did not think was about D-Bus at all.

`bigint` is not a drop-in for `number`:

```js
size + 1; // TypeError: Cannot mix BigInt and other types
size * 2; // TypeError, likewise
Math.round(size); // TypeError: Cannot convert a BigInt to a number
JSON.stringify({ size }); // TypeError: Do not know how to serialize a BigInt
size > 100; // fine, comparisons work across types
size === 100; // false! strict equality across types never holds
size == 100; // true, loose equality does
Number(size); // fine, with the precision loss you already had
```

The two that bite hardest are **arithmetic** and **`JSON.stringify`**. A
metrics counter that adds a byte total, or an HTTP handler that serialises a
device property, will throw at runtime on a value that used to work — and the
stack trace points at your serialiser, not at the D-Bus call that produced it.

So: find every 64-bit value your program actually reads, and decide for each
one whether it wants the range or the arithmetic.

```js
// wants the range: a file size, a byte counter, a timestamp in microseconds
const size = await iface.Size(); // keep it a bigint

// wants the arithmetic: a value you know is small, feeding a percentage
const pct = Number(await iface.Level()) / 100;
```

`Number()` at the boundary is not a defeat. It is the same precision you had in
1.x, made visible in one place instead of applied silently to everything.

For JSON, convert at the edge:

```js
JSON.stringify(payload, (key, value) =>
  typeof value === 'bigint' ? value.toString() : value
);
```

**Which of your values are 64-bit?** Look for `x` and `t` in the interface's
introspection XML:

```bash
dbus-native introspect --service org.freedesktop.UPower \
  --path /org/freedesktop/UPower/devices/DisplayDevice --system
```

or generate typings and let the type checker find them, which is less work:

```bash
dbus-native types --system --service org.freedesktop.UPower \
  --path /org/freedesktop/UPower --target next --out upower.d.ts
```

`--target next` emits the 2.0 shapes, so `tsc` reports every place a `bigint`
meets a `number` before you have run anything.

---

## Variants

```js
// 1.x -- the shape behind more issues than anything else in this project
const value = result[1][0];

// 2.0
const value = result;
```

Nested in a dict, which is where it usually appears:

```js
// 1.x
const udi = dict.find(([key]) => key === 'Udi')[1][1][0];

// 2.0
const { Udi } = dict;
```

**Write it once, for both**, using the accessor that shipped in 0.6:

```js
const { variantValue } = require('dbus-native');

const value = variantValue(result); // identical before and after
```

`variantValue()` reads the 1.x wrapper and is the identity on a plain value, so
a file converted to it is done — it needs no second pass at the flag day. This
is what the accessors are for; see [DBUS_DEP0002](deprecations.md#dbus_dep0002).

### The signature goes with it

`[parsedSignatureTree, [value]]` carried the variant's type. The plain shape
does not:

```js
variantSignature(result); // 's' in 1.x, undefined in 2.0
```

Almost nobody reads it — but if you do, say because you dispatch on the type of
an `a{sv}` value, there is no replacement yet and you should
[open an issue](https://github.com/sidorares/dbus-native/issues) describing the
case. Writing variants is unaffected: `new Variant('u', 9)` and the
`['u', 9]` pair both still work.

---

## Dicts

```js
// 1.x
for (const [key, value] of dict) {
  console.log(key, variantValue(value));
}
const name = dict.find(([key]) => key === 'Name')[1][1][0];

// 2.0
for (const [key, value] of Object.entries(dict)) {
  console.log(key, value);
}
const { Name } = dict;
```

**Write it once, for both**, with `toPlain()`, which converts a whole reply
recursively — pairs to objects, variants unwrapped — and is the identity on a
2.0 value:

```js
const { toPlain } = require('dbus-native');

const props = toPlain(await getAll()); // { Name: 'eth0', Mtu: 1500 }
```

Only dicts with string-like keys become objects — `s`, `o` and `g`. `a{is}`
and friends stay arrays of pairs in both versions, because an integer key is
not a JavaScript property name and a 64-bit one would lose precision on the way
back. (`toPlain()` converts them anyway, stringifying the keys, if that is what
you want — so a file using it sees objects where the parser hands out pairs.)
And a dict is told from a struct array by the parser rather than by shape, so
`a(ss)` is never mistaken for `a{ss}`.

Writing a dict has accepted a plain object since 0.11.0, so code that sends
`{ Name: 'eth0' }` needs no change. See
[DBUS_DEP0003](deprecations.md#dbus_dep0003).

---

## Doing it early

None of the above has to wait for 2.0. Both shapes are options today, per
connection:

```js
const bus = dbus.sessionBus({ plainValues: true, returnBigInt: true });
```

That is the same code path 2.0 turns on by default — not a simulation of it.
So the migration that actually works is:

1. **Convert reads to `variantValue()` and `toPlain()`** on your current
   version. Nothing changes behaviourally; every converted call site is one
   that the flag day cannot break.

2. **Find the rest with the linter.** Reading a variant is an index chain, and
   nothing in the source says what is at the end of it, so there is no complete
   codemod for this release — anyone promising one has not thought about it.
   The linter narrows it to a reviewed list instead:

   ```bash
   npx dbus-native lint src/
   src/net.js:42  DBUS_DEP0002  variant index chain `[1][1][0]`
       -> variantValue(), or a plain property read after 2.0
   ```

   It exits non-zero when there are findings, so it can gate CI while you work
   through them. Dict findings are marked `(possible)`: `for (const [k, v] of
xs)` is also ordinary JavaScript, and a linter that cries wolf gets switched
   off.

3. **Turn the options on, one connection at a time.** Because they are per
   connection, a large program can move a subsystem at a time against its real
   bus rather than all at once.

4. **Upgrade.** If steps 1–3 are done, 2.0 is a version bump.

---

## If you cannot migrate yet

```js
const { withClassicTypes } = require('dbus-native/compat');

const bus = withClassicTypes(dbus.sessionBus());
```

1.x shapes on a 2.0 connection: variants wrapped, dicts as pairs, `x`/`t` as
`number`. For code with `result[1][1][0]` in three hundred places and a reason
to upgrade that is not this.

It is available now, where it does nothing, so the import can land before the
flag day rather than during it.

Four things to know:

- **It is scoped to the connection, not to the reference.** It configures the
  bus you hand it and returns that same bus. There is one parser per socket, so
  an independent 2.0 view of the same connection is not something that can
  exist. Unrelated code with its own bus is unaffected.
- **Call it before your first call goes out.** A reply that has already been
  parsed is already the new shape, and nothing can reach back and change it.
- **It restores the old lossiness too.** `x` and `t` come back as rounded
  `number`s again — that is what "classic" means, and it is the right answer if
  your code needs a Number, but do not reach for this merely to silence a
  BigInt error. You will be reintroducing the precision bug that
  [#248](https://github.com/sidorares/dbus-native/issues/248) is about.
- **It is a holding position, not a destination.** Delete the wrapper and fix
  what `dbus-native lint` and `tsc` then point at.

---

## Reference

- [docs/deprecations.md](deprecations.md) — DBUS_DEP0001 (`ReturnLongjs`),
  DBUS_DEP0002 (variants), DBUS_DEP0003 (dicts), with the runtime warnings and
  what silences each one
- [docs/api.md](api.md) — `variantValue`, `variantSignature`, `toPlain`,
  `Variant`
- [RELEASE_PLAN.md](../RELEASE_PLAN.md) — why these changes are grouped into
  one major, and what comes after
