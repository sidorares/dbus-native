// Match rules: the language a client uses to say which messages it wants.
//
// https://dbus.freedesktop.org/doc/dbus-specification.html#message-bus-routing-match-rules
//
// A rule is comma-separated `key='value'` pairs, and every key that is present
// must match for the message to be delivered. Absent keys match everything, so
// the empty rule matches every message -- which is why AddMatch with an empty
// string is a firehose rather than a no-op.
//
// This is the client's side of the story today (bus.addMatch just posts the
// string to the daemon) and the routing table's side in lib/broker.js.

const constants = require('./constants');

const MESSAGE_TYPES = {
  method_call: constants.messageType.methodCall,
  method_return: constants.messageType.methodReturn,
  error: constants.messageType.error,
  signal: constants.messageType.signal
};

// argN and argNpath are limited to 0..63 by the specification; a rule naming
// arg64 is an error rather than a filter that never matches, because silently
// accepting it would hide a typo.
const MAX_ARG = 63;

const SCALAR_KEYS = new Set([
  'type',
  'sender',
  'interface',
  'member',
  'path',
  'path_namespace',
  'destination',
  'arg0namespace',
  'eavesdrop'
]);

/**
 * Split a rule into `[key, value]` pairs.
 *
 * Quoting follows libdbus: a single quote opens and closes a literal section,
 * and outside one a backslash escapes the next character. A literal quote is
 * therefore written by closing the section first -- `arg0='it'\''s'` is the
 * seven characters `it's`. Commas and equals signs inside quotes are data.
 */
function tokenize(rule) {
  const pairs = [];
  let key = null;
  let value = '';
  let quoted = false;
  let sawAny = false;

  const flush = () => {
    if (key === null) {
      // A pair with no '=' at all. An empty trailing segment is the harmless
      // result of a trailing comma; anything else is a malformed rule.
      if (value.trim() !== '') {
        throw new Error(`Match rule has a key with no value: "${value}"`);
      }
      return;
    }
    pairs.push([key.trim(), value]);
    key = null;
    value = '';
  };

  for (let i = 0; i < rule.length; i++) {
    const c = rule[i];
    if (quoted) {
      if (c === "'") quoted = false;
      else value += c;
      continue;
    }
    switch (c) {
      case "'":
        quoted = true;
        sawAny = true;
        break;
      case '\\': {
        // A backslash at the very end escapes nothing. libdbus accepts the
        // rule and drops it, and this has to agree: refusing a rule the daemon
        // accepts would mean a client that works against dbus-daemon fails
        // against lib/broker.js. Checked against dbus-daemon 1.14 -- see
        // test/integration/match-rules.js.
        const next = rule[++i];
        if (next !== undefined) value += next;
        break;
      }
      case '=':
        if (key === null) {
          key = value;
          value = '';
          sawAny = true;
        } else {
          value += c;
        }
        break;
      case ',':
        flush();
        break;
      default:
        value += c;
        if (c.trim() !== '') sawAny = true;
    }
  }
  if (quoted) throw new Error('Match rule has an unterminated quote');
  flush();
  if (!sawAny && pairs.length === 0) return [];
  return pairs;
}

/**
 * Parse a match rule string.
 *
 * @throws if a key is unknown or a value is not usable -- the daemon answers
 *   AddMatch with org.freedesktop.DBus.Error.MatchRuleInvalid for both, and a
 *   rule that is quietly ignored is worse than one that is refused.
 */
function parse(rule) {
  if (typeof rule !== 'string') {
    throw new Error(`Match rule must be a string, got ${typeof rule}`);
  }
  const parsed = { args: new Map(), argPaths: new Map() };

  for (const [key, value] of tokenize(rule)) {
    const argMatch = /^arg(\d+)(path)?$/.exec(key);
    if (argMatch) {
      const index = Number(argMatch[1]);
      if (index > MAX_ARG) {
        throw new Error(
          `Match rule argument index ${index} is above ${MAX_ARG}`
        );
      }
      (argMatch[2] ? parsed.argPaths : parsed.args).set(index, value);
      continue;
    }
    if (!SCALAR_KEYS.has(key)) {
      throw new Error(`Match rule has an unknown key "${key}"`);
    }
    if (key === 'type' && !Object.hasOwn(MESSAGE_TYPES, value)) {
      throw new Error(
        `Match rule type "${value}" is not one of ${Object.keys(MESSAGE_TYPES).join(', ')}`
      );
    }
    if (key === 'path_namespace' && parsed.path !== undefined) {
      throw new Error('Match rule cannot use both path and path_namespace');
    }
    if (key === 'path' && parsed.path_namespace !== undefined) {
      throw new Error('Match rule cannot use both path and path_namespace');
    }
    parsed[key] = value;
  }
  return parsed;
}

/**
 * Is `path` at or below `namespace`?
 *
 * The prefix has to end on a path separator: `/foo/bar` is below `/foo` but
 * `/foobar` is not, and a plain startsWith would say otherwise. The root
 * namespace covers everything.
 */
function underNamespace(path, namespace) {
  if (typeof path !== 'string') return false;
  if (namespace === '/') return path.startsWith('/');
  return path === namespace || path.startsWith(`${namespace}/`);
}

/** Is `name` the given bus name, or in its namespace? */
function inNameNamespace(name, namespace) {
  if (typeof name !== 'string') return false;
  return name === namespace || name.startsWith(`${namespace}.`);
}

/**
 * Does `msg` satisfy `rule`?
 *
 * `rule` may be a string or the result of parse(); routing parses once and
 * matches many times, so both are accepted.
 */
function matches(rule, msg) {
  const parsed = typeof rule === 'string' ? parse(rule) : rule;

  if (parsed.type !== undefined && msg.type !== MESSAGE_TYPES[parsed.type]) {
    return false;
  }
  // `sender` and `destination` are matched as written. The daemon resolves a
  // well-known name to its owner before comparing, which it can do because it
  // owns the name table; here there is nothing to resolve against, so a rule
  // naming a well-known sender is compared against whatever the message says.
  // lib/broker.js passes an already-resolved message.
  for (const key of ['sender', 'destination', 'interface', 'member', 'path']) {
    if (parsed[key] !== undefined && msg[key] !== parsed[key]) return false;
  }
  if (
    parsed.path_namespace !== undefined &&
    !underNamespace(msg.path, parsed.path_namespace)
  ) {
    return false;
  }

  const body = msg.body || [];
  for (const [index, expected] of parsed.args) {
    // Only string-like arguments can match; the spec restricts argN to
    // STRING, OBJECT_PATH and SIGNATURE, and anything else simply does not.
    if (typeof body[index] !== 'string' || body[index] !== expected) {
      return false;
    }
  }
  for (const [index, prefix] of parsed.argPaths) {
    const value = body[index];
    if (typeof value !== 'string') return false;
    // argNpath matches in both directions: the argument may be the prefix of
    // the rule or the rule the prefix of the argument, which is what makes it
    // useful for watching a subtree from either end.
    const ok =
      value === prefix ||
      (prefix.endsWith('/') && value.startsWith(prefix)) ||
      (value.endsWith('/') && prefix.startsWith(value));
    if (!ok) return false;
  }
  if (parsed.arg0namespace !== undefined) {
    if (!inNameNamespace(body[0], parsed.arg0namespace)) return false;
  }
  return true;
}

module.exports = { parse, matches, tokenize, MESSAGE_TYPES, MAX_ARG };
