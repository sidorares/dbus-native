// Shared plumbing for the Docker end-to-end checks.
//
// These run against the real desktop services in the container, so anything
// that depends on a particular service being present asks first and skips
// rather than failing: what starts inside a container varies with the kernel,
// with udev, and with whether there is any hardware to talk about.

const dbus = require('/work/index');

// Every call gets a deadline. Introspecting a service that is activatable but
// not running makes the daemon start it, and a container has plenty that will
// never come up -- without this the default 25 second bus timeout applies to
// each one in turn and the suite appears to hang.
const CALL_TIMEOUT = Number(process.env.E2E_CALL_TIMEOUT || 5000);

const system = (opts = {}) =>
  dbus.createClient({
    busAddress:
      process.env.DBUS_SYSTEM_BUS_ADDRESS ||
      'unix:path=/var/run/dbus/system_bus_socket',
    timeout: CALL_TIMEOUT,
    ...opts
  });

const session = (opts = {}) =>
  dbus.createClient({
    busAddress: process.env.DBUS_SESSION_BUS_ADDRESS,
    timeout: CALL_TIMEOUT,
    ...opts
  });

const DBUS = {
  destination: 'org.freedesktop.DBus',
  path: '/org/freedesktop/DBus',
  interface: 'org.freedesktop.DBus'
};

/** Every name currently on the bus, well-known and unique. */
const listNames = bus => bus.invoke({ ...DBUS, member: 'ListNames' });

/** Raw Introspect, without going through the proxy layer. */
const introspect = (bus, destination, path) =>
  bus.invoke({
    destination,
    path,
    interface: 'org.freedesktop.DBus.Introspectable',
    member: 'Introspect'
  });

const getProperty = (bus, destination, path, iface, name) =>
  bus.invoke({
    destination,
    path,
    interface: 'org.freedesktop.DBus.Properties',
    member: 'Get',
    signature: 'ss',
    body: [iface, name]
  });

const getAll = (bus, destination, path, iface) =>
  bus.invoke({
    destination,
    path,
    interface: 'org.freedesktop.DBus.Properties',
    member: 'GetAll',
    signature: 's',
    body: [iface]
  });

/**
 * Walk an object tree from `path`, depth first, using Introspect alone.
 *
 * Returns `[{path, interfaces, children}]`. This is the operation that could
 * not be done at all before the introspection fixes: a path with no interfaces
 * used to come back as its own first child, and the child list dropped
 * whichever child came first.
 */
async function walk(bus, destination, path = '/', limit = 400) {
  const { parseStringPromise } = require('/work/node_modules/xml2js');
  const found = [];
  const queue = [path];
  const seen = new Set();
  while (queue.length && found.length < limit) {
    const at = queue.shift();
    if (seen.has(at)) continue;
    seen.add(at);
    let doc;
    try {
      doc = await parseStringPromise(await introspect(bus, destination, at));
    } catch {
      continue;
    }
    const node = doc.node || {};
    const interfaces = (node.interface || []).map(i => i.$.name);
    const children = (node.node || [])
      .map(n => n.$ && n.$.name)
      .filter(Boolean);
    found.push({ path: at, interfaces, children });
    for (const child of children) {
      queue.push(at === '/' ? `/${child}` : `${at}/${child}`);
    }
  }
  return found;
}

/** Wait for `fn()` to return something truthy, or give up. */
async function eventually(fn, { timeout = 5000, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const close = (...buses) => {
  for (const bus of buses) {
    try {
      bus.connection.end();
      // end() half-closes and waits for the peer, which keeps the socket -- and
      // so the event loop -- alive after the tests are done. These connections
      // exist for the length of one file; drop them outright.
      bus.connection.stream.destroy();
    } catch {
      /* already gone */
    }
  }
};

module.exports = {
  dbus,
  system,
  session,
  DBUS,
  listNames,
  introspect,
  getProperty,
  getAll,
  walk,
  eventually,
  close
};
