// org.freedesktop.DBus.ObjectManager -- how a service publishes a tree of
// objects, and how a client enumerates one in a single round trip.
//
// BlueZ, NetworkManager, systemd and UDisks all expose their objects this way,
// so "list the devices" is `GetManagedObjects` on every real bus. Until now
// this library had a `// TODO: emit ObjectManager's InterfaceAdded` and nothing
// else, which left callers hand-decoding `a{oa{sa{sv}}}`.
//
// A manager reports the objects **strictly below** its own path, which is why
// BlueZ puts one at '/' and reports '/org/bluez/hci0'. The manager object
// itself is never in its own reply.

const constants = require('./constants');
const properties = require('./properties');

const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';

/**
 * Is `path` strictly below `root`?
 *
 * '/' is special: every path is below it, but the trailing-slash arithmetic
 * that works for '/org/bluez' would ask whether a path starts with '//'.
 */
function isBelow(root, path) {
  if (path === root) return false;
  return root === '/' ? path.startsWith('/') : path.startsWith(`${root}/`);
}

/**
 * The readable properties of one interface, as `a{sv}` body values.
 *
 * Write-only properties are omitted rather than guessed at, which is what the
 * spec asks for and what Properties.GetAll already does.
 *
 * @throws if a declaration is malformed -- the service's bug, surfaced to
 *   whoever is waiting on the reply
 */
function readableProperties(ifaceDesc, impl) {
  const out = [];
  for (const name of properties.names(ifaceDesc)) {
    const decl = properties.declaration(ifaceDesc, name);
    if (!properties.isReadable(decl.access)) continue;
    out.push([name, [decl.type, impl[name]]]);
  }
  return out;
}

/**
 * One object's interfaces and their properties: the `a{sa{sv}}` that both
 * GetManagedObjects and InterfacesAdded carry.
 *
 * `only` restricts the result to those interface names, which is what an
 * InterfacesAdded for a single newly-exported interface needs.
 */
function interfacesAndProperties(exported, only) {
  const out = [];
  for (const interfaceName of Object.keys(exported || {})) {
    if (only && !only.includes(interfaceName)) continue;
    const [ifaceDesc, impl] = exported[interfaceName];
    out.push([interfaceName, readableProperties(ifaceDesc, impl)]);
  }
  return out;
}

/**
 * Everything below `root`, as the `a{oa{sa{sv}}}` GetManagedObjects returns.
 *
 * Paths come out in export order. The spec does not require an order and no
 * implementation sorts, so imposing one would only invite someone to depend on
 * it.
 */
function managedObjects(exportedObjects, root) {
  const out = [];
  for (const path of Object.keys(exportedObjects)) {
    if (!isBelow(root, path)) continue;
    out.push([path, interfacesAndProperties(exportedObjects[path])]);
  }
  return out;
}

/** InterfacesAdded, announcing an object or a new interface on one. */
function addedSignal(serial, managerPath, path, interfaces) {
  return {
    type: constants.messageType.signal,
    serial,
    path: managerPath,
    interface: OBJECT_MANAGER,
    member: 'InterfacesAdded',
    signature: 'oa{sa{sv}}',
    body: [path, interfaces]
  };
}

/** InterfacesRemoved, naming the interfaces that went away. */
function removedSignal(serial, managerPath, path, interfaceNames) {
  return {
    type: constants.messageType.signal,
    serial,
    path: managerPath,
    interface: OBJECT_MANAGER,
    member: 'InterfacesRemoved',
    signature: 'oas',
    body: [path, interfaceNames]
  };
}

/**
 * The manager responsible for `path`, or undefined.
 *
 * The deepest one wins, so a service may nest managers -- '/' reporting
 * everything and '/org/example/devices' reporting a subtree -- and each object
 * is announced by exactly one of them. Announcing to both would double every
 * signal for anyone subscribed at the root.
 */
function managerFor(managerPaths, path) {
  let best;
  for (const manager of managerPaths) {
    if (!isBelow(manager, path)) continue;
    if (best === undefined || manager.length > best.length) best = manager;
  }
  return best;
}

const introspectionXML =
  '  <interface name="org.freedesktop.DBus.ObjectManager">\n' +
  '    <method name="GetManagedObjects">\n' +
  '      <arg type="a{oa{sa{sv}}}" name="objects" direction="out"/>\n' +
  '    </method>\n' +
  '    <signal name="InterfacesAdded">\n' +
  '      <arg type="o" name="object_path"/>\n' +
  '      <arg type="a{sa{sv}}" name="interfaces_and_properties"/>\n' +
  '    </signal>\n' +
  '    <signal name="InterfacesRemoved">\n' +
  '      <arg type="o" name="object_path"/>\n' +
  '      <arg type="as" name="interfaces"/>\n' +
  '    </signal>\n' +
  '  </interface>';

module.exports = {
  OBJECT_MANAGER,
  isBelow,
  readableProperties,
  interfacesAndProperties,
  managedObjects,
  addedSignal,
  removedSignal,
  managerFor,
  introspectionXML
};
