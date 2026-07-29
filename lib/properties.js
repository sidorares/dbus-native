// Property declarations and the PropertiesChanged signal.
//
// An interface descriptor declares properties as `{ Greeting: 's' }` -- a
// signature per name. That form says nothing about access, so `interfaceToXML`
// used to advertise everything as `readwrite` whatever the service intended,
// and `Properties.Set` would write a property meant to be read-only.
//
// The declaration is therefore widened rather than replaced: a value may still
// be a signature string, or it may be `{ type, access }`. The string form is
// what almost every existing service uses and keeps meaning exactly what it
// did, so nothing needs rewriting.

const constants = require('./constants');

const ACCESS = new Set(['read', 'write', 'readwrite']);

/**
 * Normalise one property declaration.
 *
 * @returns {{type: string, access: string}|undefined} undefined if undeclared
 */
function declaration(iface, name) {
  const props = iface && iface.properties;
  // `Object.hasOwn` rather than a truthiness check: a property legitimately
  // declared as the empty signature would otherwise look undeclared.
  if (!props || !Object.hasOwn(props, name)) return undefined;
  const decl = props[name];
  if (typeof decl === 'string') return { type: decl, access: 'readwrite' };
  if (decl && typeof decl === 'object' && typeof decl.type === 'string') {
    const access = decl.access === undefined ? 'readwrite' : decl.access;
    if (!ACCESS.has(access)) {
      throw new Error(
        `Property "${name}" declares access "${access}"; expected one of ${[...ACCESS].join(', ')}`
      );
    }
    return { type: decl.type, access };
  }
  throw new Error(
    `Property "${name}" must be declared as a signature string or { type, access }`
  );
}

/** Every declared property name, in declaration order. */
function names(iface) {
  const props = iface && iface.properties;
  return props ? Object.keys(props) : [];
}

const isReadable = access => access === 'read' || access === 'readwrite';
const isWritable = access => access === 'write' || access === 'readwrite';

/**
 * Build an org.freedesktop.DBus.Properties.PropertiesChanged signal.
 *
 * `changed` carries the new values; `invalidated` names properties whose value
 * has changed but is not being broadcast -- which is what the spec wants for
 * anything write-only or expensive to compute, rather than omitting it and
 * leaving subscribers with a stale value.
 */
function changedSignal(serial, path, interfaceName, changed, invalidated) {
  return {
    type: constants.messageType.signal,
    serial,
    path,
    interface: 'org.freedesktop.DBus.Properties',
    member: 'PropertiesChanged',
    signature: 'sa{sv}as',
    body: [interfaceName, changed, invalidated]
  };
}

module.exports = {
  declaration,
  names,
  isReadable,
  isWritable,
  changedSignal
};
