const assert = require('assert');

const parseSignature = require('./signature');
const Marshallers = require('./marshallers');
const Writer = require('./writer');
const { Variant, dumpSignature, isPlainObject } = require('./values');

// Element types whose array body starts on an 8-byte boundary. The padding
// between the length and the first element is not counted in the length.
const ALIGN_8 = new Set(['x', 't', 'd', '{', '(', 'r']);

const STRING_TYPES = new Set(['g', 'o', 's']);

// JSON.stringify throws on a BigInt, so building a diagnostic out of a body
// that contains one used to replace the real error -- "does not match message
// signature" became "Do not know how to serialize a BigInt", which says
// nothing about the actual problem. 64-bit values are exactly the case these
// messages need to describe, so they render them here instead.
function describe(value) {
  try {
    return JSON.stringify(value, (_key, v) =>
      typeof v === 'bigint' ? `${v}n` : v
    );
  } catch {
    // Circular, or anything else JSON dislikes: the diagnostic must not become
    // the failure.
    return String(value);
  }
}

module.exports = function marshall(signature, data, offset = 0) {
  const tree = parseSignature(signature);
  if (!Array.isArray(data) || data.length !== tree.length) {
    throw new Error(
      `message body does not match message signature. Body:${describe(
        data
      )}, signature:${signature}`
    );
  }
  const writer = new Writer(offset);
  writeStruct(writer, tree, data);
  return writer.result();
};

// ---------------------------------------------------------------------------
// Plain objects as dicts
// ---------------------------------------------------------------------------
//
// A dict has always been written as an array of [key, value] pairs, with every
// `a{sv}` value spelled out as a variant. That is a lot of ceremony for what is
// usually a bag of settings, and it is the single most-asked question about
// this library (#3, #91, #132).
//
// So a plain object is accepted anywhere a dict is expected. Inside one, values
// are inferred -- and an array is just an array, never a [signature, value]
// pair. Wrap a value in `Variant` when the inferred type is not what you want,
// which is also how you write a type inference cannot reach.
//
// The array-of-pairs form is untouched: it stays the explicit spelling, and
// nothing about it infers.

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

// Object keys are strings, so a numerically-keyed dict needs converting back.
// 'x' and 't' are left alone -- their marshaller already parses strings, and
// going through Number() would lose precision above 2^53.
const NUMERIC_KEYS = new Set(['y', 'n', 'q', 'i', 'u', 'd']);

/**
 * The d-bus signature for a JavaScript value.
 *
 * Only reached for values inside a plain object, where there is nothing else
 * the value could mean. `Variant` overrides it.
 */
function inferSignature(value) {
  if (value instanceof Variant) return value.signature;

  switch (typeof value) {
    case 'string':
      return 's';
    case 'boolean':
      return 'b';
    case 'bigint':
      return 'x';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(
          `Cannot infer a d-bus type for ${value} -- d-bus has no infinity or NaN`
        );
      }
      // A non-integer is a double; an integer is the smallest of i/x that
      // holds it. Use Variant to ask for 'u', 'y' or a double integer.
      if (!Number.isInteger(value)) return 'd';
      return value >= INT32_MIN && value <= INT32_MAX ? 'i' : 'x';
    case 'undefined':
      throw new Error(
        "Serialisation of JS 'undefined' type is not supported by d-bus"
      );
  }

  if (value === null) {
    throw new Error('Serialisation of null value is not supported by d-bus');
  }
  if (ArrayBuffer.isView(value)) return 'ay';
  if (Array.isArray(value)) return inferArraySignature(value);
  if (isPlainObject(value)) return 'a{sv}';

  throw new Error(
    `Cannot infer a d-bus type for ${inferenceLabel(
      value
    )} -- wrap it in a Variant to say what it is`
  );
}

/**
 * Name a value that has no d-bus type.
 *
 * `describe` goes through JSON, which renders a function or a symbol as
 * `undefined` -- and "cannot infer a type for undefined" points at the wrong
 * problem entirely.
 */
function inferenceLabel(value) {
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'symbol') return 'a symbol';
  const name = value?.constructor?.name;
  const rendered = describe(value);
  if (rendered === undefined) return name ? `a ${name}` : String(value);
  return name && name !== 'Object' ? `a ${name} (${rendered})` : rendered;
}

function inferArraySignature(value) {
  if (value.length === 0) {
    throw new Error(
      "Cannot infer a d-bus type for an empty array -- use a Variant, e.g. new Variant('as', [])"
    );
  }
  const first = inferSignature(value[0]);
  for (let i = 1; i < value.length; ++i) {
    const next = inferSignature(value[i]);
    if (next !== first) {
      throw new Error(
        `Cannot infer a d-bus type for a mixed array (element 0 is '${first}', element ${i} is '${next}') -- d-bus arrays are homogeneous, so use a Variant, or an array of Variants for 'av'`
      );
    }
  }
  return `a${first}`;
}

/** Turn a plain object into the [key, value] pairs the writer expects. */
function dictEntries(entryNode, obj) {
  const [keyNode, valueNode] = entryNode.child;
  const inferValues = valueNode.type === 'v';

  return Object.keys(obj).map(key => {
    const value = obj[key];
    return [
      NUMERIC_KEYS.has(keyNode.type) ? numericKey(keyNode.type, key) : key,
      // Only a variant needs a signature attached; `a{ss}` values are written
      // as declared, exactly as they are from the pairs form.
      inferValues && !(value instanceof Variant)
        ? new Variant(inferSignature(value), value)
        : value
    ];
  });
}

function numericKey(type, key) {
  const n = Number(key);
  if (!Number.isFinite(n)) {
    throw new Error(
      `Dict key ${JSON.stringify(key)} is not a number, but the signature says 'a{${type}...}'`
    );
  }
  return n;
}

/**
 * Whether a value is one of the classic variant spellings, rather than a value
 * to infer a type for.
 *
 * `['s', 'hello']` is `[signature, value]`, and `[tree, [value]]` is what the
 * reader used to hand back. Both are two-element arrays -- and so is
 * `['a', 'b']`, an ordinary `as`, which is the whole difficulty. The test is
 * therefore exact: a signature is a string, and a parse tree is an array of
 * nodes carrying a `type`. Everything else infers, which is what lets a value
 * read under the 2.0 shapes be written straight back out.
 *
 * The one case that stays ambiguous is a two-element array of strings, read as
 * `[signature, value]`. Write `new Variant('as', ['a', 'b'])` to mean the
 * array. This predates the 2.0 shapes and is the reason `Variant` is the
 * spelling to prefer.
 */
function isClassicVariant(data) {
  if (!Array.isArray(data) || data.length !== 2) return false;
  if (typeof data[0] === 'string') return true;
  return (
    Array.isArray(data[0]) &&
    Array.isArray(data[1]) &&
    data[0].length > 0 &&
    typeof data[0][0]?.type === 'string'
  );
}

function writeStruct(writer, tree, data) {
  if (tree.length !== data.length) {
    throw new Error('Invalid struct data');
  }
  for (let i = 0; i < tree.length; ++i) {
    write(writer, tree[i], data[i]);
  }
}

function write(writer, ele, data) {
  switch (ele.type) {
    case '(':
    case '{':
      writer.align(8);
      writeStruct(writer, ele.child, data);
      break;
    case 'a':
      writeArray(writer, ele, data);
      break;
    case 'v': {
      let signature, value;
      if (data instanceof Variant) {
        // The explicit spelling, and the one to reach for when the inferred
        // type is not the one you want.
        signature = data.signature;
        value = data.value;
      } else if (isClassicVariant(data)) {
        if (Array.isArray(data[0])) {
          // The reader's own shape, [parsedTree, [value]] -- a variant that
          // came back off the wire. Passing one straight to another service
          // used to fail with a confusing complaint about type 'g', because
          // the writer wanted a signature string where the reader had put a
          // tree. Nested variants inside `value` are in the same shape and
          // are handled when write() recurses onto them.
          signature = dumpSignature(data[0]);
          value = data[1].length === 1 ? data[1][0] : data[1];
        } else {
          signature = data[0];
          value = data[1];
        }
      } else {
        // A plain value, which is what `variants: 'plain'` -- the default
        // since 2.0 -- hands back. Inferred exactly as a value inside `a{sv}`
        // is, so a variant read off the wire can be written straight back.
        signature = inferSignature(data);
        value = data;
      }
      writeSimple(writer, 'g', signature);
      const tree = parseSignature(signature);
      assert(tree.length === 1);
      write(writer, tree[0], value);
      break;
    }
    default:
      writeSimple(writer, ele.type, data);
  }
}

function writeArray(writer, ele, data) {
  const child = ele.child[0];

  // A dict may be given as a plain object instead of an array of pairs. Done
  // before the length is reserved so the two forms write identical bytes.
  if (child.type === '{' && isPlainObject(data)) {
    data = dictEntries(child, data);
  }

  // The length counts the body only, so it is written first and patched once
  // we know how far the elements reached.
  const lengthPos = writer.reserveLength();
  if (ALIGN_8.has(child.type)) writer.align(8);
  const start = writer.pos;

  if (child.type === 'y' && ArrayBuffer.isView(data)) {
    // Fast path: a byte array backed by a Buffer or TypedArray is already the
    // wire representation, so copy it in one go. Walking it element by element
    // costs an allocation per byte and is thousands of times slower.
    writer.raw(
      Buffer.isBuffer(data)
        ? data
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    );
  } else {
    if (!Array.isArray(data) && typeof data?.length !== 'number') {
      throw new Error(
        child.type === '{'
          ? `Expected an array of [key, value] pairs, or a plain object, for a dict, got ${describe(data)}`
          : `Expected an array for signature 'a${child.type}', got ${describe(data)}`
      );
    }
    for (let i = 0; i < data.length; ++i) write(writer, child, data[i]);
  }

  writer.patchLength(lengthPos, writer.pos - start);
}

function writeSimple(writer, type, data) {
  if (typeof data === 'undefined')
    throw new Error(
      "Serialisation of JS 'undefined' type is not supported by d-bus"
    );
  if (data === null)
    throw new Error('Serialisation of null value is not supported by d-bus');

  if (Buffer.isBuffer(data)) data = data.toString(); // encoding?
  if (STRING_TYPES.has(type) && typeof data !== 'string') {
    throw new Error(
      `Expected string or buffer argument, got ${describe(
        data
      )} of type '${type}'`
    );
  }

  const marshaller = Marshallers.MakeSimpleMarshaller(type);
  // check() returns a value only for the 64-bit types, which convert to Long.
  const checked = marshaller.check(data);
  marshaller.marshall(writer, checked === undefined ? data : checked);
}
