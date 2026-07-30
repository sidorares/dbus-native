const parseSignature = require('./signature');
const constants = require('./constants');
const { isValidObjectPath } = require('./names');

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

// Converting whatever a caller passed for `x`/`t` into the 64 bits to write.
//
// This used to build a Long.js object and hand its two 32-bit words to the
// writer, so every 64-bit value went through Long -- including a `bigint`,
// which was stringified and re-parsed on the way. The representation is now
// `bigint` throughout and Node writes the eight bytes directly; Long.js is
// still *accepted* as input, and is still what `ReturnLongjs` hands back on
// the read side, but nothing internal depends on it.
//
// Every error message here is load-bearing: test/unmarshall-basic.js and
// test/bigint.js assert on them, and the wording differs by input type
// because the paths did.
const MAX_INT64 = 9223372036854775807n;
const MIN_INT64 = -9223372036854775808n;
const MAX_UINT64 = 18446744073709551615n;

const inRange = (value, signed) =>
  signed
    ? value >= MIN_INT64 && value <= MAX_INT64
    : value >= 0n && value <= MAX_UINT64;

// A Long.js object, or anything else carrying its {low, high, unsigned}
// shape. Recognised structurally so that accepting one costs no dependency.
const isLongShaped = val =>
  val !== null &&
  typeof val === 'object' &&
  typeof val.low === 'number' &&
  typeof val.high === 'number';

const fromLongShaped = function (val) {
  // Long stores two signed 32-bit words, low first.
  const low = BigInt(val.low >>> 0);
  const high = BigInt(val.high | 0);
  const value = (high << 32n) + low;
  // An unsigned Long's high word is also unsigned, so a negative result means
  // the top bit was set rather than that the value is negative.
  return val.unsigned && value < 0n ? value + (1n << 64n) : value;
};

const fromString = function (val, signed) {
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

  if (val === '') {
    throw new Error("Error converting string to 64bit integer 'empty string'");
  }

  // Long.js parsed silently and wrapped, and the round-trip comparison below
  // is what caught both garbage and overflow. BigInt refuses garbage outright
  // and never wraps, so both become the same message they always were.
  const notConverted = () =>
    new Error(
      `Data: '${val}' did not convert correctly to ${
        signed ? 'signed' : 'unsigned'
      } 64 bit`
    );

  let value;
  try {
    if (radix === 16) {
      // BigInt() rejects a sign in front of the 0x prefix, so the digits are
      // parsed on their own and negated after.
      value = val.startsWith('-')
        ? -BigInt(`0x${val.slice(1)}`)
        : BigInt(`0x${val}`);
    } else {
      value = BigInt(val);
    }
  } catch {
    throw notConverted();
  }
  if (!inRange(value, signed)) throw notConverted();
  return value;
};

const makeBigInt = function (val, signed) {
  if (typeof val === 'bigint') {
    if (!inRange(val, signed)) {
      throw new Error(
        `Data: ${val} was out of range (64-bit ${signed ? 'signed' : 'unsigned'})`
      );
    }
    return val;
  }
  if (val instanceof Number) val = val.valueOf();
  if (typeof val === 'number') {
    try {
      // A double cannot carry more than 53 bits exactly, and silently losing
      // the difference is worse than refusing it.
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
    return BigInt(val);
  }
  if (typeof val === 'string' || val instanceof String) {
    return fromString(String(val), signed);
  }
  if (isLongShaped(val)) {
    // Long.js has always insisted the object's signedness match the field, on
    // the grounds that a mismatch is more likely a bug than an intention.
    if (signed && val.unsigned) {
      throw new Error(
        'Longjs object is unsigned, but marshalling into signed 64 bit field'
      );
    }
    if (!signed && !val.unsigned) {
      throw new Error(
        'Longjs object is signed, but marshalling into unsigned 64 bit field'
      );
    }
    const value = fromLongShaped(val);
    if (!inRange(value, signed)) {
      throw new Error(
        `Data: ${value} was out of range (64-bit ${signed ? 'signed' : 'unsigned'})`
      );
    }
    return value;
  }
  throw new Error(
    `Error converting object to 64bit integer '${describeForError(val)}'`
  );
};

const describeForError = val =>
  val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;

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
  // UNIX_FD -- a uint32 on the wire, and *not* a file descriptor.
  //
  // "The value is an index into the array of file descriptors that accompany
  // the message" (D-Bus specification, Basic types). The descriptors travel as
  // ancillary data; the body carries positions in that array. So this marshals
  // exactly like `u`, and it is the transport that has to be able to carry
  // `msg.fds` alongside -- see constants.noFdTransport.
  h: {
    check(data) {
      checkInteger(data);
      checkRange(0, 0xffffffff, data);
    },
    marshall: (writer, data) => writer.uint32(data)
  },
  // UINT64
  t: {
    check: data => makeBigInt(data, false),
    marshall: (writer, data) => writer.int64(data, true)
  },
  // INT64
  x: {
    check: data => makeBigInt(data, true),
    marshall: (writer, data) => writer.int64(data, false)
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
    throw new Error(constants.unsupportedType(signature));
  }
  return marshaller;
};

exports.MakeSimpleMarshaller = MakeSimpleMarshaller;
