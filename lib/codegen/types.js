// Map d-bus signatures onto TypeScript types.
//
// Two of them depend on the connection's value shapes rather than on the
// signature alone -- a dict is an object or an array of pairs, and 64-bit is a
// bigint or a number -- so a generated file records which target it was
// produced for and is regenerated with one command. 'plain' is the default and
// describes the default shapes; 'classic' describes a connection reading with
// `plainValues: false, returnBigInt: false`.

const parseSignature = require('../signature');

const SCALARS = {
  y: 'number', // BYTE
  b: 'boolean', // BOOLEAN
  n: 'number', // INT16
  q: 'number', // UINT16
  i: 'number', // INT32
  u: 'number', // UINT32
  d: 'number', // DOUBLE
  s: 'string', // STRING
  o: 'string', // OBJECT_PATH
  g: 'string', // SIGNATURE
  h: 'number' // UNIX_FD -- parsed, but not supported on the wire yet
};

function isDictEntry(node) {
  return node.type === '{';
}

/**
 * @param {object} node    a parsed signature node
 * @param {object} options { target: 'plain' | 'classic' }
 */
function nodeToTs(node, options) {
  const target = (options && options.target) || 'plain';

  if (node.type === 'x' || node.type === 't') {
    return target === 'classic' ? 'number' : 'bigint';
  }
  if (SCALARS[node.type]) return SCALARS[node.type];

  if (node.type === 'v') {
    // A variant carries its own type; the reader has to narrow it.
    return target === 'classic' ? 'ClassicVariant' : 'unknown';
  }

  if (node.type === 'a') {
    const child = node.child[0];
    // 'ay' is handed back as a Buffer rather than number[]
    if (child.type === 'y') return 'Buffer';

    if (isDictEntry(child)) {
      const key = nodeToTs(child.child[0], options);
      const value = nodeToTs(child.child[1], options);
      if (target !== 'classic') {
        // a plain object, keyed by whatever the key type is
        return key === 'string' || key === 'number'
          ? `Record<${key}, ${value}>`
          : `Map<${key}, ${value}>`;
      }
      // an array of [key, value] pairs
      return `Array<[${key}, ${value}]>`;
    }
    return `${wrap(nodeToTs(child, options))}[]`;
  }

  if (node.type === '(' || node.type === 'r') {
    return `[${node.child.map(c => nodeToTs(c, options)).join(', ')}]`;
  }

  // '{' outside an array, and anything else we do not model
  return 'unknown';
}

// Parenthesise unions/tuples before appending [] so `a(is)` is not `[number, string][]`
// misread, and `av` is not `ClassicVariant[]` when it should be.
function wrap(type) {
  return /[|&]/.test(type) ? `(${type})` : type;
}

/** Convert a full signature (which may hold several complete types). */
function signatureToTs(signature, options) {
  if (!signature) return [];
  return parseSignature(signature).map(node => nodeToTs(node, options));
}

/** The TypeScript type of a reply: nothing, one value, or a tuple. */
function returnToTs(signature, options) {
  const types = signatureToTs(signature, options);
  if (types.length === 0) return 'void';
  if (types.length === 1) return types[0];
  return `[${types.join(', ')}]`;
}

module.exports = { nodeToTs, signatureToTs, returnToTs, SCALARS };
