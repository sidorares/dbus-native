// The client side of org.freedesktop.DBus.ObjectManager: a live view of a
// service's object tree.
//
// This is the half that removes the hand-decoding. `GetManagedObjects` returns
// `a{oa{sa{sv}}}` -- three levels of dict with variants at the bottom -- and
// then you have to keep it up to date from InterfacesAdded, InterfacesRemoved
// and PropertiesChanged, all of which arrive as separate signals that have to
// be matched against the right service. Everyone using BlueZ or NetworkManager
// writes this, and writes it slightly wrong.

const { EventEmitter } = require('events');
const { toPlain } = require('./values');
const { OBJECT_MANAGER } = require('./object-manager');

const PROPERTIES = 'org.freedesktop.DBus.Properties';
const DBUS = 'org.freedesktop.DBus';

/**
 * A live view of the objects a service manages below one path.
 *
 * Values are plain -- `{ path: { interface: { property: value } } }` -- in
 * every connection shape, because a view whose contents depended on how the
 * connection was configured would be useless to write against.
 *
 * @fires ManagedObjects#added   (path, interfaces)
 * @fires ManagedObjects#removed (path, interfaceNames)
 * @fires ManagedObjects#changed (path, interfaceName, changed, invalidated)
 * @fires ManagedObjects#stale   (newOwner) -- the service was replaced
 */
class ManagedObjects extends EventEmitter {
  constructor(bus, service, path, options) {
    super();
    this.bus = bus;
    this.service = service;
    this.path = path;
    this.objects = {};
    this.owner = undefined;
    this.closed = false;

    this._trackProperties = options.properties !== false;
    this._rules = [];
    // Signals that arrive between subscribing and the GetManagedObjects reply
    // are held here rather than dropped. See start().
    this._pending = [];
    this._buffering = true;
    this._onMessage = msg => this._handle(msg);
  }

  /** Every managed object path. */
  paths() {
    return Object.keys(this.objects);
  }

  /** One object's interfaces, or undefined. */
  get(path) {
    return this.objects[path];
  }

  /**
   * The objects implementing an interface, as `{ path: properties }`.
   *
   * The interface name is already known to the caller, so returning it again
   * in the value would only be something to index past.
   */
  filter(interfaceName) {
    const out = {};
    for (const [path, interfaces] of Object.entries(this.objects)) {
      if (Object.hasOwn(interfaces, interfaceName)) {
        out[path] = interfaces[interfaceName];
      }
    }
    return out;
  }

  /**
   * Subscribe, then fetch.
   *
   * The order matters and is the bug this class exists to not have. Fetching
   * first leaves a window in which an object appears, its InterfacesAdded goes
   * nowhere, and the view is permanently missing it. Subscribing first means
   * signals can arrive describing objects the snapshot has not delivered yet,
   * so they are buffered and replayed once it has.
   */
  async start() {
    // Signals carry the sender's unique name, never the well-known one, so
    // matching on `service` directly would never fire.
    this.owner = this.service.startsWith(':')
      ? this.service
      : await this.bus.getNameOwner(this.service);

    this.bus.connection.on('message', this._onMessage);

    const sender = `sender='${this.service}'`;
    await this._watch(
      `type='signal',${sender},path='${this.path}',interface='${OBJECT_MANAGER}'`
    );
    if (this._trackProperties) {
      // path_namespace rather than path: the properties belong to the managed
      // objects below this one, not to the manager.
      await this._watch(
        `type='signal',${sender},interface='${PROPERTIES}',member='PropertiesChanged',path_namespace='${this.path}'`
      );
    }
    // Not scoped to the service: the argument *is* the name, and a
    // NameOwnerChanged is sent by the daemon rather than by the service.
    await this._watch(
      `type='signal',sender='${DBUS}',interface='${DBUS}',member='NameOwnerChanged',arg0='${this.service}'`
    );

    const reply = await this.bus.invoke({
      destination: this.service,
      path: this.path,
      interface: OBJECT_MANAGER,
      member: 'GetManagedObjects'
    });
    this.objects = toPlain(reply);

    // Replay. A signal for an object already in the snapshot is idempotent:
    // InterfacesAdded overwrites with the same values, and a removal that the
    // snapshot already reflects finds nothing to delete.
    this._buffering = false;
    const pending = this._pending;
    this._pending = [];
    for (const msg of pending) this._apply(msg);

    return this;
  }

  async _watch(rule) {
    await this.bus.addMatch(rule);
    this._rules.push(rule);
  }

  _handle(msg) {
    if (this.closed) return;
    if (msg.sender !== this.owner && msg.sender !== DBUS) return;
    if (this._buffering) {
      this._pending.push(msg);
      return;
    }
    this._apply(msg);
  }

  _apply(msg) {
    if (msg['interface'] === OBJECT_MANAGER && msg.path === this.path) {
      if (msg.member === 'InterfacesAdded') {
        const [path, interfaces] = msg.body;
        const added = toPlain(interfaces);
        this.objects[path] = { ...this.objects[path], ...added };
        this.emit('added', path, added);
      } else if (msg.member === 'InterfacesRemoved') {
        const [path, names] = msg.body;
        const object = this.objects[path];
        if (!object) return;
        for (const name of names) delete object[name];
        // An object with no interfaces left is gone, which is how the spec
        // says a client should read it.
        if (Object.keys(object).length === 0) delete this.objects[path];
        this.emit('removed', path, names);
      }
      return;
    }

    if (
      this._trackProperties &&
      msg['interface'] === PROPERTIES &&
      msg.member === 'PropertiesChanged'
    ) {
      const [interfaceName, changedRaw, invalidated = []] = msg.body;
      const object = this.objects[msg.path];
      // A PropertiesChanged for something we are not tracking -- a path below
      // the manager that it never reported -- is not ours to apply.
      if (!object || !object[interfaceName]) return;
      const changed = toPlain(changedRaw);
      Object.assign(object[interfaceName], changed);
      // Invalidated means "changed, value not sent". Dropping the key is
      // honest: keeping a value the service has disowned is how a view starts
      // lying. Re-read with Properties.Get if you need it.
      for (const name of invalidated) delete object[interfaceName][name];
      this.emit('changed', msg.path, interfaceName, changed, invalidated);
      return;
    }

    if (
      msg['interface'] === DBUS &&
      msg.member === 'NameOwnerChanged' &&
      msg.body &&
      msg.body[0] === this.service
    ) {
      const newOwner = msg.body[2];
      if (newOwner === this.owner) return;
      // Not resynchronised automatically: re-fetching would race with whatever
      // the caller is doing with the view, and a half-updated tree is worse
      // than a stale one that says so. The alternative -- staying quiet -- is
      // how a view silently stops working after a service restart.
      this.emit('stale', newOwner);
    }
  }

  /** Remove the match rules and stop listening. Idempotent. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.bus.connection.removeListener('message', this._onMessage);
    const rules = this._rules;
    this._rules = [];
    for (const rule of rules) {
      try {
        await this.bus.removeMatch(rule);
      } catch {
        // The connection may already be going away, which is the common case
        // for a view being closed. Nothing useful to do, and throwing here
        // would mask whatever is actually shutting down.
      }
    }
  }

  // Lets a view be scoped rather than closed by hand -- the match rules are
  // exactly the resource people forget to release.
  async [Symbol.asyncDispose]() {
    await this.close();
  }
}

module.exports = { ManagedObjects };
