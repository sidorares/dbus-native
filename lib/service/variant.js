const assert = require('assert');
const parseSignature = require('../signature');

class Variant {
  constructor(signature, value) {
    this.signature = signature;
    this.value = value;
  }
}

function valueIsVariant(value) {
  // used for the marshaller variant type
  return Array.isArray(value) && value.length === 2 && value[0][0].type;
}

function typesEqual(typeA, typeB) {
  if (typeof typeA === 'string') {
    typeA = parseSignature(typeA);
  }
  if (typeof typeB === 'string') {
    typeB = parseSignature(typeB);
  }

  try {
    assert.deepEqual(typeA, typeB);
  } catch (e) {
    return false;
  }

  return true;
}

function collapseSignature(value) {
  if (value.child.length === 0) {
    return value.type;
  }

  let type = value.type;
  for (let i = 0; i < value.child.length; ++i) {
    type += collapseSignature(value.child[i]);
  }
  if (type[0] === '{') {
    type += '}';
  } else if (type[0] === '(') {
    type += ')';
  }
  return type;
}

function parse(variant) {
  // parses a single complete variant
  let type = variant[0][0];
  let value = variant[1][0];

  if (!type.child.length) {
    if (valueIsVariant(value)) {
      return new Variant(collapseSignature(value[0][0]), parse(value));
    } else {
      return value;
    }
  }

  if (type.type === 'a') {
    if (type.child[0].type === '{') {
      // this is an array of dictionary entries
      let result = {};
      for (let i = 0; i < value.length; ++i) {
        // dictionary keys must have basic types
        result[value[i][0]] = parse([[type.child[0].child[1]], [value[i][1]]]);
      }
      return result;
    } else {
      // other arrays only have one type
      let result = [];
      for (let i = 0; i < value.length; ++i) {
        result[i] = parse([[type.child[0]], [value[i]]]);
      }
      return result;
    }
  } else if (type.type === '(') {
    // structs have types equal to the number of children
    let result = [];
    for (let i = 0; i < value.length; ++i) {
      result[i] = parse([[type.child[i]], [value[i]]]);
    }
    return result;
  }
}

function jsToMarshalFmt(signature, value) {
  // TODO better error handling because this is called on user functions and
  // they may have mismatched signature and value
  let signatureStr = null;
  if (typeof signature === 'string') {
    signatureStr = signature;
    signature = parseSignature(signature)[0];
  } else {
    signatureStr = collapseSignature(signature);
  }

  if (signature.child.length === 0) {
    if (value.constructor === Variant) {
      return [value.signature, value.value];
    } else {
      return [signature.type, value];
    }
  }

  if (signature.type === 'a') {
    let result = [];
    if (signature.child[0].type === '{') {
      // this is an array of dictionary elements
      for (let k of Object.keys(value)) {
        let v = value[k];
        if (v.constructor === Variant) {
          result.push([k, jsToMarshalFmt(v.signature, v.value)]);
        } else {
          result.push([k, jsToMarshalFmt(signature.child[0].child[1], v)[1]]);
        }
      }
    } else {
      for (let v of value) {
        if (v.constructor === Variant) {
          result.push(jsToMarshalFmt(v.signature, v.value));
        } else {
          result.push(jsToMarshalFmt(signature.child[0], v)[1]);
        }
      }
    }
    return [collapseSignature(signature), result];
  } else if (signature.type === '(') {
    let result = [];
    for (let i = 0; i < value.length; ++i) {
      let v = value[i];
      if (v.constructor === Variant) {
        result.push(jsToMarshalFmt(v.signature, v.value));
      } else {
        result.push(jsToMarshalFmt(signature.child[i], v)[1]);;
      }
    }
    return [signatureStr, result];
  }
}

module.exports = {
  parse: parse,
  typesEqual: typesEqual,
  valueIsVariant: valueIsVariant,
  collapseSignature: collapseSignature,
  jsToMarshalFmt: jsToMarshalFmt,
  Variant: Variant
};
