// The D-Bus naming rules.
//
// https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names
//
// Four kinds of name, with four different rule sets that are easy to confuse:
// object paths use `/` and allow leading digits, interface and error names use
// `.` and do not, member names allow neither, and bus names are interface names
// that additionally allow `-` (and, when unique, a leading `:` and digits).
//
// Property names are a fifth kind, and are *not* in the spec at all -- see
// isValidPropertyName.
//
// These are applied to what we *send*. Incoming names are left alone -- be
// strict in what you emit and lenient in what you accept, which is also what
// the spec allows a receiver to do.

const MAX_NAME_LENGTH = 255;

// Each of these has a forced boundary between repetitions -- the separator is
// never a member of the element character class -- so they match in linear time
// and cannot be made to backtrack.
const INTERFACE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const MEMBER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const WELL_KNOWN_BUS_NAME =
  /^[A-Za-z_-][A-Za-z0-9_-]*(?:\.[A-Za-z_-][A-Za-z0-9_-]*)+$/;
// Unique names are ':' followed by elements that may start with a digit.
const UNIQUE_BUS_NAME = /^:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/**
 * An object path: '/', or '/'-separated non-empty elements of [A-Za-z0-9_].
 *
 * Scanned rather than matched: this runs on the path header of every outgoing
 * message, and a hand-rolled loop is both quicker and obviously free of
 * backtracking. The spec sets no length limit on paths.
 */
function isValidObjectPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path[0] !== '/') return false;
  if (path.length === 1) return true; // the root path
  if (path[path.length - 1] === '/') return false; // no trailing slash

  let elementLength = 0;
  for (let i = 1; i < path.length; ++i) {
    const c = path[i];
    if (c === '/') {
      if (elementLength === 0) return false; // empty element, i.e. '//'
      elementLength = 0;
      continue;
    }
    const isAllowed =
      (c >= 'A' && c <= 'Z') ||
      (c >= 'a' && c <= 'z') ||
      (c >= '0' && c <= '9') ||
      c === '_';
    if (!isAllowed) return false;
    elementLength++;
  }
  return elementLength > 0;
}

/** An interface name: two or more '.'-separated elements, max 255 bytes. */
function isValidInterfaceName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_NAME_LENGTH &&
    INTERFACE_NAME.test(name)
  );
}

/** An error name. The spec gives these the same rules as interface names. */
const isValidErrorName = isValidInterfaceName;

/** A member name: one element, no dots, max 255 bytes. */
function isValidMemberName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_NAME_LENGTH &&
    MEMBER_NAME.test(name)
  );
}

/**
 * A property name: a member name that may also contain '-'.
 *
 * The spec's "Valid Names" section covers object paths, interface names, bus
 * names, member names and error names. Property names are not among them, and
 * nothing on the bus parses one: a property name travels as an ordinary string
 * *argument* to Properties.Get/Set/GetAll, never in a message header, so the
 * daemon never inspects it. The introspection DTD declares the attribute as
 * `<!ATTLIST property name CDATA #REQUIRED>` -- any character data at all.
 *
 * GDBus, sd-bus and python-dbus all introspect, read and write a hyphenated
 * property without complaint (busctl even lists it as `.my-prop`), and '-' is
 * the GObject property convention, so services written against GObject reach
 * for it naturally. 0.11.0 applied the member-name rules here and broke them;
 * this is the narrowest rule that takes them back.
 *
 * The rest of the member charset is kept rather than allowing anything: a
 * property name goes straight into the introspection XML, and restricting it
 * to characters that need no escaping keeps that reply well-formed. It also
 * still catches the typos worth catching -- a space, a dot, a quote.
 */
function isValidPropertyName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_NAME_LENGTH &&
    PROPERTY_NAME.test(name)
  );
}

/** A bus name: well-known like an interface name, or a unique ':1.23'. */
function isValidBusName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
  return name[0] === ':'
    ? UNIQUE_BUS_NAME.test(name)
    : WELL_KNOWN_BUS_NAME.test(name);
}

// Why each kind of name is rejected, so the error says what to fix rather than
// just restating the input.
const RULES = {
  'object path': 'must start with "/" and contain only [A-Za-z0-9_] elements',
  'interface name':
    'must be two or more dot-separated elements of [A-Za-z_][A-Za-z0-9_]*, at most 255 bytes',
  'error name':
    'must be two or more dot-separated elements of [A-Za-z_][A-Za-z0-9_]*, at most 255 bytes',
  'member name':
    'must be a single element of [A-Za-z_][A-Za-z0-9_]* with no dots, at most 255 bytes',
  'property name':
    'must be a single element of [A-Za-z_][A-Za-z0-9_-]* with no dots, at most 255 bytes',
  'bus name':
    'must be a unique name like ":1.23", or two or more dot-separated elements, at most 255 bytes'
};

const VALIDATORS = {
  'object path': isValidObjectPath,
  'interface name': isValidInterfaceName,
  'error name': isValidErrorName,
  'member name': isValidMemberName,
  'property name': isValidPropertyName,
  'bus name': isValidBusName
};

/**
 * Throw unless `value` is a valid name of `kind`.
 *
 * `context` names where it came from, since by the time an interface name is
 * rejected the caller may have passed several.
 */
function assertValidName(kind, value, context) {
  if (VALIDATORS[kind](value)) return value;
  const where = context ? ` for ${context}` : '';
  throw new Error(
    `Invalid ${kind}${where}: ${JSON.stringify(value)} -- ${RULES[kind]}`
  );
}

module.exports = {
  MAX_NAME_LENGTH,
  isValidObjectPath,
  isValidInterfaceName,
  isValidErrorName,
  isValidMemberName,
  isValidPropertyName,
  isValidBusName,
  assertValidName
};
