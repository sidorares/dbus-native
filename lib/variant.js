const assert = require('assert');
const parseSignature = require('./signature');

function valueIsVariant(value) {
  return Array.isArray(value) && value.length == 2 && value[0][0].type;
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

function parse(variant) {
  // parses a single complete variant
  var type = variant[0][0];
  var value = variant[1][0];

  if (!type.child.length) {
    if (valueIsVariant(value)) {
      return parse(value);
    } else {
      return value;
    }
  }

  if (type.type === 'a') {
    if (type.child[0].type === '{') {
      // this is an array of dictionary entries
      var result = {};
      for (var i = 0; i < value.length; ++i) {
        // dictionary keys must have basic types
        result[value[i][0]] = parse([[type.child[0].child[1]], [value[i][1]]]);
      }
      return result;
    } else {
      // other arrays only have one type
      var result = [];
      for (var i = 0; i < value.length; ++i) {
        result[i] = parse([[type.child[0]], [value[i]]]);
      }
      return result;
    }
  } else if (type.type === '(') {
    // structs have types equal to the number of children
    var result = [];
    for (var i = 0; i < value.length; ++i) {
      result[i] = parse([[type.child[i]], [value[i]]]);
    }
    return result;
  }
}

module.exports = {
  parse: parse,
  typesEqual: typesEqual
};
