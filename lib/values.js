// Helpers for reading and writing d-bus values in a way that survives the
// type-system change planned for 2.0.
//
// Today a variant unmarshals as `[parsedSignatureTree, [value]]` and a dict as
// an array of `[key, value]` pairs. In 2.0 they become the value itself and a
// plain object. Code written against `variantValue()` and `toPlain()` behaves
// identically before and after, so it can be migrated now, on a released
// version, with no flag day.
//
// See RELEASE_PLAN.md.

const util = require('util');

// Values that came out of this library are tagged, so the helpers below do not
// have to guess from shape. That matters because `a{ss}` and `a(ss)` unmarshal
// to structurally identical arrays -- a heuristic would convert both, and be
// wrong about one of them.
const VARIANT = Symbol.for('dbus.variant');
const DICT = Symbol.for('dbus.dict');

function tag(value, marker) {
  // Non-enumerable, so it is invisible to JSON.stringify, deepStrictEqual and
  // anything else that walks own enumerable properties.
  Object.defineProperty(value, marker, { value: true, enumerable: false });
  return value;
}

/**
 * An explicitly typed value, for the places where the signature cannot be
 * inferred -- writing a `v`, or picking between numeric types.
 *
 * Accepted by the marshaller anywhere a `[signature, value]` pair is today, so
 * it is also the forward-compatible way to *write* variants.
 */
class Variant {
  constructor(signature, value) {
    this.signature = signature;
    this.value = value;
  }

  [util.inspect.custom](depth, options) {
    return `Variant(${util.inspect(this.signature, options)}, ${util.inspect(
      this.value,
      options
    )})`;
  }
}

function isTaggedVariant(value) {
  return Array.isArray(value) && value[VARIANT] === true;
}

// Fallback for values that did not come from this library's parser -- hand
// built fixtures, or anything constructed by a caller. Deliberately strict.
function looksLikeClassicVariant(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Array.isArray(value[0]) &&
    value[0].length > 0 &&
    value[0].every(
      node =>
        node &&
        typeof node === 'object' &&
        typeof node.type === 'string' &&
        Array.isArray(node.child)
    ) &&
    Array.isArray(value[1])
  );
}

/**
 * Read the value out of a variant, whatever shape it is in.
 *
 * classic: [tree, [value]] -> value
 * 2.0:     value           -> value  (identity)
 */
function variantValue(value) {
  if (value instanceof Variant) return value.value;
  if (isTaggedVariant(value) || looksLikeClassicVariant(value)) {
    const values = value[1];
    return values.length === 1 ? values[0] : values;
  }
  return value;
}

/**
 * Read the signature of a variant, or undefined if it is not one (or has
 * already been flattened, in which case the type information is gone).
 */
function variantSignature(value) {
  if (value instanceof Variant) return value.signature;
  if (isTaggedVariant(value) || looksLikeClassicVariant(value)) {
    return dumpSignature(value[0]);
  }
  return undefined;
}

function dumpSignature(nodes) {
  let out = '';
  for (const node of nodes) {
    out += node.type + dumpSignature(node.child);
    if (node.type === '{') out += '}';
    if (node.type === '(') out += ')';
  }
  return out;
}

/**
 * Convert a value to plain JavaScript, recursively: dicts become objects and
 * variants are unwrapped.
 *
 * classic: [['Udi', [tree, ['/sys/...']]]] -> { Udi: '/sys/...' }
 * 2.0:     { Udi: '/sys/...' }             -> unchanged
 *
 * Arrays that are not tagged as dicts are left as arrays, so `a(ss)` is not
 * mistaken for `a{ss}`.
 */
function toPlain(value) {
  if (value instanceof Variant) return toPlain(value.value);
  if (isTaggedVariant(value) || looksLikeClassicVariant(value)) {
    return toPlain(variantValue(value));
  }
  if (Array.isArray(value)) {
    if (value[DICT] === true) {
      const out = {};
      for (const entry of value) out[entry[0]] = toPlain(entry[1]);
      return out;
    }
    return value.map(toPlain);
  }
  return value;
}

module.exports = {
  Variant,
  variantValue,
  variantSignature,
  toPlain,
  // internal
  VARIANT,
  DICT,
  tag,
  dumpSignature
};
