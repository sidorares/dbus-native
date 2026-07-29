const parseSignature = require('./signature');
const { isValidObjectPath } = require('./names');
const Long = require('long');

// The validation helpers are shared by every marshaller and do not depend on
// the signature, so they live at module scope rather than being rebuilt for
// each one.

function checkValidString(data) {
  if (typeof data !== 'string') {
    throw new Error(`Data: ${data} was not of type string`);
  } else if (data.indexOf('\0') !== -1) {
    throw new Error('String contains null byte');
  }
}

function checkValidSignature(data) {
  if (data.length > 0xff) {
    throw new Error(
      `Data: ${data} is too long for signature type (${data.length} > 255)`
    );
  }

  let parenCount = 0;
  for (let ii = 0; ii < data.length; ++ii) {
    if (parenCount > 32) {
      throw new Error(
        `Maximum container type nesting exceeded in signature type:${data}`
      );
    }
    switch (data[ii]) {
      case '(':
        ++parenCount;
        break;
      case ')':
        --parenCount;
        break;
      default:
        /* no-op */
        break;
    }
  }
  parseSignature(data);
}

const checkRange = function (minValue, maxValue, data) {
  if (data > maxValue || data < minValue) {
    throw new Error('Number outside range');
  }
};

const checkInteger = function (data) {
  if (typeof data !== 'number') {
    throw new Error(`Data: ${data} was not of type number`);
  }
  if (Math.floor(data) !== data) {
    throw new Error(`Data: ${data} was not an integer`);
  }
};

const checkBoolean = function (data) {
  if (!(typeof data === 'boolean' || data === 0 || data === 1))
    throw new Error(`Data: ${data} was not of type boolean`);
};

// This is essentially a tweaked version of 'fromValue' from Long.js with error checking.
// This can take number or string of decimal characters or 'Long' instance (or Long-style object with props low,high,unsigned).
// Range constants for `bigint`, which has no bounds of its own -- unlike every
// other input here it will happily hold a number far too large for the field.
const MAX_INT64 = 9223372036854775807n;
const MIN_INT64 = -9223372036854775808n;
const MAX_UINT64 = 18446744073709551615n;

const makeLong = function (val, signed) {
  if (val instanceof Long) return val;
  if (val instanceof Number) val = val.valueOf();
  // Accepted on write whatever the read option is, so code can be migrated to
  // BigInt one call at a time rather than in a flag day. Range-checked here
  // because Long.fromString would wrap silently.
  if (typeof val === 'bigint') {
    if (signed) {
      if (val > MAX_INT64 || val < MIN_INT64)
        throw new Error(`Data: ${val} was out of range (64-bit signed)`);
    } else if (val > MAX_UINT64 || val < 0n) {
      throw new Error(`Data: ${val} was out of range (64-bit unsigned)`);
    }
    return Long.fromString(val.toString(), !signed);
  }
  if (typeof val === 'number') {
    try {
      // Long.js won't alert you to precision loss in passing more than 53 bit ints through a double number, so we check here
      checkInteger(val);
      if (signed) {
        checkRange(-0x1fffffffffffff, 0x1fffffffffffff, val);
      } else {
        checkRange(0, 0x1fffffffffffff, val);
      }
    } catch (e) {
      e.message += ' (Number type can only carry 53 bit integer)';
      throw e;
    }
    try {
      return Long.fromNumber(val, !signed);
    } catch (e) {
      e.message = `Error converting number to 64bit integer "${e.message}"`;
      throw e;
    }
  }
  if (typeof val === 'string' || val instanceof String) {
    let radix = 10;
    val = val.trim().toUpperCase(); // remove extra whitespace and make uppercase (for hex)
    if (val.substring(0, 2) === '0X') {
      radix = 16;
      val = val.substring(2);
    } else if (val.substring(0, 3) === '-0X') {
      // unusual, but just in case?
      radix = 16;
      val = `-${val.substring(3)}`;
    }
    val = val.replace(/^0+(?=\d)/, ''); // dump leading zeroes
    let data;
    try {
      data = Long.fromString(val, !signed, radix);
    } catch (e) {
      e.message = `Error converting string to 64bit integer '${e.message}'`;
      throw e;
    }
    // If string represents a number outside of 64 bit range, it can quietly overflow.
    // We assume if things converted correctly the string coming out of Long should match what went into it.
    if (data.toString(radix).toUpperCase() !== val)
      throw new Error(
        `Data: '${val}' did not convert correctly to ${
          signed ? 'signed' : 'unsigned'
        } 64 bit`
      );
    return data;
  }
  // Throws for non-objects, converts non-instanceof Long:
  try {
    return Long.fromBits(val.low, val.high, val.unsigned);
  } catch (e) {
    e.message = `Error converting object to 64bit integer '${e.message}'`;
    throw e;
  }
};

const checkLong = function (data, signed) {
  if (!Long.isLong(data)) {
    data = makeLong(data, signed);
  }

  // Do we enforce that Long.js object unsigned/signed match the field even if it is still in range?
  // Probably, might help users avoid unintended bugs?
  if (signed) {
    if (data.unsigned)
      throw new Error(
        'Longjs object is unsigned, but marshalling into signed 64 bit field'
      );
    if (data.gt(Long.MAX_VALUE) || data.lt(Long.MIN_VALUE)) {
      throw new Error(`Data: ${data} was out of range (64-bit signed)`);
    }
  } else {
    if (!data.unsigned)
      throw new Error(
        'Longjs object is signed, but marshalling into unsigned 64 bit field'
      );
    // NOTE: data.gt(Long.MAX_UNSIGNED_VALUE) will catch if Long.js object is a signed value but is still within unsigned range!
    //  Since we are enforcing signed type matching between Long.js object and field, this note should not matter.
    if (data.gt(Long.MAX_UNSIGNED_VALUE) || data.lt(0)) {
      throw new Error(`Data: ${data} was out of range (64-bit unsigned)`);
    }
  }
  return data;
};

/**
 * The marshaller table, keyed by single-character signature.
 *
 * `check` validates and returns the value to write (only the 64-bit types
 * need to convert, everything else writes what it was given).
 * `marshall` writes it into a Writer.
 */
const marshallers = {
  // STRING
  s: {
    check: checkValidString,
    marshall: (writer, data) => writer.string(data)
  },
  // OBJECT_PATH -- written exactly like a string, but not any string will do.
  // This runs on the path header field of every outgoing message.
  o: {
    check(data) {
      checkValidString(data);
      if (!isValidObjectPath(data)) {
        throw new Error(
          `Data: ${data} is not a valid object path -- must start with "/" and contain only [A-Za-z0-9_] elements`
        );
      }
    },
    marshall: (writer, data) => writer.string(data)
  },
  // SIGNATURE
  g: {
    check(data) {
      checkValidString(data);
      checkValidSignature(data);
    },
    marshall: (writer, data) => writer.signature(data)
  },
  // BYTE
  y: {
    check(data) {
      checkInteger(data);
      checkRange(0x00, 0xff, data);
    },
    marshall: (writer, data) => writer.byte(data)
  },
  // BOOLEAN - serialised as a 0/1 unsigned 32 bit int
  b: {
    check: checkBoolean,
    marshall: (writer, data) => writer.uint32(data ? 1 : 0)
  },
  // INT16
  n: {
    check(data) {
      checkInteger(data);
      checkRange(-0x7fff - 1, 0x7fff, data);
    },
    marshall: (writer, data) => writer.int16(data)
  },
  // UINT16
  q: {
    check(data) {
      checkInteger(data);
      checkRange(0, 0xffff, data);
    },
    marshall: (writer, data) => writer.uint16(data)
  },
  // INT32
  i: {
    check(data) {
      checkInteger(data);
      checkRange(-0x7fffffff - 1, 0x7fffffff, data);
    },
    marshall: (writer, data) => writer.int32(data)
  },
  // UINT32
  u: {
    check(data) {
      checkInteger(data);
      checkRange(0, 0xffffffff, data);
    },
    marshall: (writer, data) => writer.uint32(data)
  },
  // UINT64
  t: {
    check: data => checkLong(data, false),
    marshall(writer, data) {
      writer.align(8);
      writer.uint32(data.low);
      writer.uint32(data.high);
    }
  },
  // INT64
  x: {
    check: data => checkLong(data, true),
    marshall(writer, data) {
      writer.align(8);
      writer.uint32(data.low);
      writer.uint32(data.high);
    }
  },
  // DOUBLE
  d: {
    check(data) {
      if (typeof data !== 'number') {
        throw new Error(`Data: ${data} was not of type number`);
      } else if (Number.isNaN(data)) {
        throw new Error(`Data: ${data} was not a number`);
      } else if (!Number.isFinite(data)) {
        throw new Error('Number outside range');
      }
    },
    marshall: (writer, data) => writer.double(data)
  }
};

/**
 * MakeSimpleMarshaller
 * @param signature - the signature of the data you want to check
 * @returns a marshaller with "check" and "marshall" methods
 *
 * check raises an error if the data is invalid for the signature. For the
 * 64-bit types it also returns the converted Long; for everything else it
 * returns undefined and the original value should be written.
 *
 * Marshallers are stateless, so the same object is returned every time rather
 * than being rebuilt per value.
 */
const MakeSimpleMarshaller = function (signature) {
  const marshaller = marshallers[signature];
  if (!marshaller) {
    throw new Error(`Unknown data type format: ${signature}`);
  }
  return marshaller;
};

exports.MakeSimpleMarshaller = MakeSimpleMarshaller;
