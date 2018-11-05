// https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-marshaling-object-path
const pathRe = /^[A-Za-z0-9_]+$/

function isObjectPathValid(path) {
  return typeof path === 'string' &&
      path &&
      path[0] === '/' &&
      (path.length === 1 ||
        (path[path.length-1] !== '/' &&
         path.split('/').slice(1).every((p) => p && pathRe.test(p))));
}

function assertObjectPathValid(path) {
  if (!isObjectPathValid(path)) {
    throw new Error(`Invalid object path: ${path}`);
  }
}

// https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface
const elementRe = /^[A-Za-z_][A-Za-z0-9_]*$/
function isInterfaceNameValid(name) {
  return typeof name === 'string' &&
    name &&
    name.length > 0 &&
    name.length <= 255 &&
    name[0] !== '.' &&
    name.indexOf('.') !== -1 &&
    name.split('.').every((n) => n && elementRe.test(n));
}

function assertInterfaceNameValid(name) {
  if (!isInterfaceNameValid(name)) {
    throw new Error(`Invalid interface name: ${name}`);
  }
}

function isMemberNameValid(name) {
  return typeof name === 'string' &&
    name &&
    name.length > 0 &&
    name.length <= 255 &&
    elementRe.test(name);
}

function assertMemberNameValid(name) {
  if (!assertMemberNameValid) {
    throw new Error(`Invalid member name: ${name}`);
  }
}

module.exports = {
  isObjectPathValid: isObjectPathValid,
  assertObjectPathValid: assertObjectPathValid,
  isInterfaceNameValid: isInterfaceNameValid,
  assertInterfaceNameValid: assertInterfaceNameValid,
  isMemberNameValid: isMemberNameValid,
  assertMemberNameValid: assertMemberNameValid
};
