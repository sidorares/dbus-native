// The `dbus-send` shaped subcommands: call a method, read or write a property,
// list what is on the bus.
//
// Issue #56 asked how to run a particular `dbus-send` line with this library,
// and thirteen comments later the honest answer was still "write a script". The
// script is small; not having to write it is the point.

const dbus = require('../../index');
const { parseArguments, parseArgument } = require('./dbus-args');
const { variantValue, variantSignature, toPlain } = require('../values');

const PROPERTIES = 'org.freedesktop.DBus.Properties';

/**
 * The value shapes this tool needs, stated rather than inherited.
 *
 * Both are pinned because printing a reply is not the same job as consuming
 * one, and the defaults are tuned for consuming.
 *
 * `returnBigInt` because a tool whose job is to show you what came back must
 * not round it on the way: read as a Number,
 * uint64:18446744073709551615 comes out as 18446744073709552000.
 *
 * `plainValues: false` because `describe()` prints a variant as
 * `variant u 501`, and the only place that `u` exists is the parsed signature
 * tree that `plainValues` throws away. Left to follow the default, this
 * command would silently stop printing types the day 2.0 flips it.
 */
const SHAPE = { returnBigInt: true, plainValues: false };

/** Open the bus the flags asked for. */
function connect(argv) {
  const options = { ...SHAPE };
  if (argv.address) {
    return dbus.createClient({ busAddress: argv.address, ...options });
  }
  if (argv.system) {
    return dbus.createClient({
      busAddress:
        process.env.DBUS_SYSTEM_BUS_ADDRESS ||
        'unix:path=/var/run/dbus/system_bus_socket',
      ...options
    });
  }
  return dbus.sessionBus(options);
}

/**
 * Split `com.example.Iface.Member` into its two halves.
 *
 * The whole thing is one positional argument because that is how dbus-send
 * takes it, and copying a dbus-send line is the reason this exists.
 */
function splitMember(text) {
  if (typeof text !== 'string' || !text.includes('.')) {
    throw new Error(
      `Expected INTERFACE.MEMBER, got "${text}" -- e.g. org.freedesktop.DBus.ListNames`
    );
  }
  const at = text.lastIndexOf('.');
  return { interfaceName: text.slice(0, at), member: text.slice(at + 1) };
}

/**
 * Render a reply for a person to read.
 *
 * `--json` is there for a pipeline, and prints the plain shape rather than the
 * wire shape: a variant as its value, a dict as an object. A BigInt has no JSON
 * representation, so it becomes a string rather than throwing.
 */
function render(values, argv) {
  if (argv.json) {
    return JSON.stringify(
      toPlain(values.length === 1 ? values[0] : values),
      (key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2
    );
  }
  if (values.length === 0) return '';
  return values.map(value => describe(value, 0)).join('\n');
}

/** One value, in something close to dbus-send's output. */
function describe(value, depth) {
  const pad = '  '.repeat(depth);

  const signature = variantSignature(value);
  if (signature !== undefined) {
    return `${pad}variant ${signature} ${describe(variantValue(value), 0).trim()}`;
  }
  if (Buffer.isBuffer(value)) {
    return `${pad}bytes [${[...value].join(' ')}]`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    // An array of pairs is almost always a dict; printing it as one is what a
    // reader wants, and being wrong about it costs nothing but a shape.
    const looksLikeDict = value.every(
      entry => Array.isArray(entry) && entry.length === 2
    );
    if (looksLikeDict) {
      const body = value
        .map(
          ([key, item]) =>
            `${pad}  ${describe(key, 0).trim()} -> ${describe(item, 0).trim()}`
        )
        .join('\n');
      return `${pad}{\n${body}\n${pad}}`;
    }
    return `${pad}[\n${value.map(item => describe(item, depth + 1)).join('\n')}\n${pad}]`;
  }
  if (value === null || value === undefined) return `${pad}${value}`;
  if (typeof value === 'bigint') return `${pad}${value}`;
  if (typeof value === 'string') return `${pad}"${value}"`;
  if (typeof value === 'object') {
    return `${pad}${JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? v.toString() : v))}`;
  }
  return `${pad}${value}`;
}

/** A body from either the `type:value` shorthand or --signature plus --body. */
function buildBody(argv, args) {
  if (argv.signature !== undefined) {
    if (args.length > 0) {
      throw new Error(
        'Use either --signature with --body, or type:value arguments -- not both'
      );
    }
    let body;
    try {
      body = argv.body === undefined ? [] : JSON.parse(argv.body);
    } catch (err) {
      throw new Error(`--body is not valid JSON: ${err.message}`, {
        cause: err
      });
    }
    if (!Array.isArray(body)) {
      throw new Error('--body must be a JSON array of arguments');
    }
    return { signature: argv.signature, body };
  }
  return parseArguments(args);
}

/** dbus-native call --dest NAME PATH INTERFACE.MEMBER [args...] */
async function call(positionals, argv) {
  const [path, memberSpec, ...args] = positionals;
  if (!argv.dest) throw new Error('Need --dest, the bus name to call');
  if (!path || !memberSpec) {
    throw new Error(
      'Need an object path and INTERFACE.MEMBER, e.g. /org/freedesktop/DBus org.freedesktop.DBus.ListNames'
    );
  }
  const { interfaceName, member } = splitMember(memberSpec);
  const { signature, body } = buildBody(argv, args);

  const bus = connect(argv);
  try {
    const msg = {
      destination: argv.dest,
      path,
      interface: interfaceName,
      member,
      ...(signature ? { signature, body } : {})
    };
    if (argv['no-auto-start']) {
      msg.flags = require('../constants').flags.noAutoStart;
    }
    if (argv['no-reply']) {
      msg.flags =
        (msg.flags || 0) | require('../constants').flags.noReplyExpected;
      bus.connection.message({ ...msg, serial: bus.nextSerial() });
      // Nothing comes back, so the only thing left to do is let the write land.
      await new Promise(resolve => setImmediate(resolve));
      return '';
    }
    // The callback form rather than the promise: awaiting a call flattens a
    // one-value reply, which makes `as` indistinguishable from two values. The
    // callback gets every value separately, and `this.signature` says what the
    // reply actually was -- worth printing, as dbus-send does.
    const { signature: replySignature, values } = await new Promise(
      (resolve, reject) => {
        bus.invoke(
          msg,
          { timeout: Number(argv.timeout) || 25000 },
          function reply(err, ...received) {
            if (err) return reject(err);
            resolve({
              signature: this && this.signature,
              values: received
            });
          }
        );
      }
    );
    const output = render(values, argv);
    if (argv.json || !replySignature) return output;
    return `reply ${replySignature}\n${output}`;
  } finally {
    bus.connection.end();
  }
}

/** dbus-native get --dest NAME PATH INTERFACE PROPERTY */
async function get(positionals, argv) {
  const [path, interfaceName, property] = positionals;
  if (!argv.dest) throw new Error('Need --dest, the bus name to read from');
  if (!path || !interfaceName || !property) {
    throw new Error('Need PATH INTERFACE PROPERTY');
  }
  const bus = connect(argv);
  try {
    const reply = await bus.invoke(
      {
        destination: argv.dest,
        path,
        interface: PROPERTIES,
        member: 'Get',
        signature: 'ss',
        body: [interfaceName, property]
      },
      { timeout: Number(argv.timeout) || 25000 }
    );
    return render([reply], argv);
  } finally {
    bus.connection.end();
  }
}

/** dbus-native set --dest NAME PATH INTERFACE PROPERTY type:value */
async function set(positionals, argv) {
  const [path, interfaceName, property, value] = positionals;
  if (!argv.dest) throw new Error('Need --dest, the bus name to write to');
  if (!path || !interfaceName || !property || value === undefined) {
    throw new Error(
      'Need PATH INTERFACE PROPERTY VALUE, where VALUE is type:value e.g. string:hello'
    );
  }
  // A property is always written as a variant, so the type has to be given --
  // there is nothing to infer it from.
  const parsed = parseArgument(value);
  const variant =
    parsed.signature === 'v' ? parsed.value : [parsed.signature, parsed.value];

  const bus = connect(argv);
  try {
    await bus.invoke(
      {
        destination: argv.dest,
        path,
        interface: PROPERTIES,
        member: 'Set',
        signature: 'ssv',
        body: [interfaceName, property, variant]
      },
      { timeout: Number(argv.timeout) || 25000 }
    );
    return '';
  } finally {
    bus.connection.end();
  }
}

/** dbus-native list [--activatable] */
async function list(positionals, argv) {
  const bus = connect(argv);
  try {
    const names = await bus.invokeDbus(
      { member: argv.activatable ? 'ListActivatableNames' : 'ListNames' },
      { timeout: Number(argv.timeout) || 25000 }
    );
    const wanted = argv.all
      ? names
      : names.filter(name => !name.startsWith(':'));
    if (argv.json) return JSON.stringify(wanted.sort(), null, 2);
    return wanted.sort().join('\n');
  } finally {
    bus.connection.end();
  }
}

module.exports = { call, get, set, list, splitMember, describe, render, SHAPE };
