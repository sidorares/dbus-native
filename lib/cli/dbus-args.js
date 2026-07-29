// `type:value` command-line arguments, the way dbus-send spells them.
//
//   string:hello  int32:-7  boolean:true  objpath:/com/example/Obj
//   array:string:a,b,c      dict:string:uint32:width,800,height,600
//   variant:int32:42
//
// The point of copying dbus-send's syntax rather than inventing one is that
// people arrive with a dbus-send command line they want to run. What it cannot
// express -- structs, nesting past one level, a value containing a comma -- is
// what `--signature` with a JSON body is for, which is a shape this library is
// better at than dbus-send is.

/** dbus-send's type words, and the signature character each stands for. */
const TYPES = {
  string: 's',
  objpath: 'o',
  signature: 'g',
  byte: 'y',
  boolean: 'b',
  int16: 'n',
  uint16: 'q',
  int32: 'i',
  uint32: 'u',
  int64: 'x',
  uint64: 't',
  double: 'd'
};

// Inclusive bounds per integer type. The marshaller checks these too, but it
// speaks in signature characters -- a message about `q` is no help to someone
// who typed `uint16`.
const RANGES = {
  y: [0n, 255n],
  n: [-32768n, 32767n],
  q: [0n, 65535n],
  i: [-2147483648n, 2147483647n],
  u: [0n, 4294967295n],
  x: [-9223372036854775808n, 9223372036854775807n],
  t: [0n, 18446744073709551615n]
};

// Above this a Number cannot be trusted, so 64-bit values stay BigInt. The
// marshaller takes either.
const EXACT = new Set(['x', 't']);

const fail = message => {
  throw new Error(message);
};

/** Split on the first colon only, so a value may contain colons. */
function splitOnce(text) {
  const at = text.indexOf(':');
  if (at === -1) return [text, null];
  return [text.slice(0, at), text.slice(at + 1)];
}

function scalarType(word) {
  const type = TYPES[word];
  if (!type) {
    fail(
      `Unknown type "${word}". Known types: ${Object.keys(TYPES).join(', ')}`
    );
  }
  return type;
}

/** Turn the text after `type:` into a value of that signature character. */
function parseScalar(type, text, where) {
  const at = where ? ` in ${where}` : '';
  if (text === null) fail(`Missing value after "${type}"${at}`);

  switch (type) {
    case 's':
    case 'o':
    case 'g':
      return text;

    case 'b':
      if (text === 'true' || text === '1') return true;
      if (text === 'false' || text === '0') return false;
      return fail(`boolean${at} must be true or false, got "${text}"`);

    case 'd': {
      const value = Number(text);
      if (!Number.isFinite(value)) {
        return fail(`double${at} must be a finite number, got "${text}"`);
      }
      return value;
    }

    default: {
      if (!/^[+-]?\d+$/.test(text)) {
        return fail(`${type}${at} must be an integer, got "${text}"`);
      }
      const value = BigInt(text);
      const [low, high] = RANGES[type];
      if (value < low || value > high) {
        return fail(
          `${text} is out of range for ${type}${at} (${low}..${high})`
        );
      }
      return EXACT.has(type) ? value : Number(value);
    }
  }
}

/**
 * Split a comma-separated element list.
 *
 * dbus-send has no escape for a comma inside an element and neither does this;
 * the error says what to use instead rather than silently splitting the value.
 */
function elements(text, where) {
  if (text === null) fail(`Missing elements${where ? ` in ${where}` : ''}`);
  if (text === '') return [];
  return text.split(',');
}

/**
 * One element of a container of variants: its own `type:value`.
 *
 * Returned as `[signature, value]`, which is what the marshaller wants for a
 * variant.
 */
function parseVariantElement(text, where) {
  const [word, rest] = splitOnce(text);
  const type = scalarType(word);
  return [type, parseScalar(type, rest, where)];
}

/**
 * Parse one `type:value` argument.
 *
 * @returns {{signature: string, value: unknown}}
 */
function parseArgument(text) {
  if (typeof text !== 'string')
    fail(`Argument must be a string, got ${typeof text}`);
  const [word, rest] = splitOnce(text);

  if (word === 'array') {
    const [elementWord, list] = splitOnce(rest === null ? '' : rest);
    const where = `array:${elementWord}`;
    if (elementWord === 'variant') {
      return {
        signature: 'av',
        value: elements(list, where).map(item =>
          parseVariantElement(item, where)
        )
      };
    }
    const element = scalarType(elementWord);
    return {
      signature: `a${element}`,
      value: elements(list, where).map(item =>
        parseScalar(element, item, where)
      )
    };
  }

  if (word === 'dict') {
    const [keyWord, afterKey] = splitOnce(rest === null ? '' : rest);
    const [valueWord, list] = splitOnce(afterKey === null ? '' : afterKey);
    const key = scalarType(keyWord);
    const where = `dict:${keyWord}:${valueWord}`;
    // a{sv} is the single most common dict on the bus -- Notify's hints,
    // Properties.GetAll, NetworkManager's settings -- so `variant` has to be
    // usable as the value type. Each element then carries its own type, which
    // works because a type:value pair contains no comma.
    const variantValues = valueWord === 'variant';
    const value = variantValues ? 'v' : scalarType(valueWord);

    const flat = elements(list, where);
    if (flat.length % 2 !== 0) {
      fail(`${where} needs an even number of elements, got ${flat.length}`);
    }
    const pairs = [];
    for (let i = 0; i < flat.length; i += 2) {
      pairs.push([
        parseScalar(key, flat[i], where),
        variantValues
          ? parseVariantElement(flat[i + 1], where)
          : parseScalar(value, flat[i + 1], where)
      ]);
    }
    return { signature: `a{${key}${value}}`, value: pairs };
  }

  if (word === 'variant') {
    const [innerWord, inner] = splitOnce(rest === null ? '' : rest);
    const type = scalarType(innerWord);
    // The marshaller takes a variant as [signature, value].
    return {
      signature: 'v',
      value: [type, parseScalar(type, inner, `variant:${innerWord}`)]
    };
  }

  const type = scalarType(word);
  return { signature: type, value: parseScalar(type, rest) };
}

/**
 * Parse a whole argument list into the signature and body a call needs.
 *
 * @returns {{signature: string, body: unknown[]}}
 */
function parseArguments(args) {
  const parsed = (args || []).map(parseArgument);
  return {
    signature: parsed.map(arg => arg.signature).join(''),
    body: parsed.map(arg => arg.value)
  };
}

module.exports = { parseArgument, parseArguments, parseScalar, TYPES };
