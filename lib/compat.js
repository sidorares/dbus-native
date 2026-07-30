// Escape hatches for code that cannot be migrated yet.
//
// Deliberately a subpath (`dbus-native/compat`) rather than options on the
// client. An option is invisible at the call site, inherited by code that never
// asked for it, and awkward to remove. An import is greppable, obviously
// temporary, and deleting it is one line.
//
// See docs/migrating-to-0.7.md and docs/migrating-to-2.0.md.

/**
 * Reconstruct the pre-0.7 error value.
 *
 * Before 0.7 a failed call delivered the raw message body -- an array of the
 * error reply's arguments, or `[]` when the body was empty -- carrying
 * non-enumerable `name`, `message`, `dbusName` and `reply` properties added in
 * 0.6.
 *
 * Only errors that came from an error *reply* were ever arrays. A timeout, an
 * abort or a dead connection has no message body and was already delivered as
 * an Error object in 0.6, so those are returned unchanged rather than
 * flattened into a misleading `[]`.
 *
 * @param {unknown} err the error a 0.7 callback or rejection produced
 * @returns {unknown} the array shape where there was one, otherwise `err`
 */
function toClassicError(err) {
  // Already classic, or not an error we produced.
  if (!err || Array.isArray(err) || typeof err !== 'object') return err;
  // Locally-generated errors (timeout, abort, connection closed) never had an
  // array form -- `reply` is what marks an error that came off the wire.
  if (!err.reply) return err;

  const body = Array.isArray(err.body) ? Array.from(err.body) : [];
  for (const [key, value] of Object.entries({
    name: 'DBusError',
    message: err.message,
    dbusName: err.dbusName,
    reply: err.reply
  })) {
    Object.defineProperty(body, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: true
    });
  }
  return body;
}

// What 1.x handed back, spelled as options. `returnBigInt: false` is the lossy
// path on purpose: a `t` above 2^53 came back rounded in 1.x, and code that
// depends on getting a Number depends on that too.
//
// `variants: 'tree'` is stated rather than left to follow `plainValues`,
// because a caller who opted into `variants: 'wrap'` would otherwise keep the
// Variants -- and this function's whole promise is that nothing arrives in a
// shape 1.x did not produce.
const CLASSIC_TYPES = {
  plainValues: false,
  returnBigInt: false,
  variants: 'tree'
};

/**
 * Read 1.x value shapes on a 2.0 connection.
 *
 *     const bus = withClassicTypes(dbus.sessionBus());
 *
 * A variant comes back as `[signatureTree, [value]]`, a string-keyed dict as an
 * array of pairs, and `x`/`t` as a lossy `number` -- whatever the defaults have
 * become. For code with `result[1][1][0]` in three hundred places and no
 * appetite for touching all of them at once.
 *
 * **It configures the connection it is given and returns it**, rather than
 * producing an independent view of the same bus. There is one parser per socket
 * and the shape is decided as a message is read, so a second view with
 * different shapes is not a thing that can exist. The scope is therefore the
 * connection: unrelated code with its own bus is unaffected, which is the
 * property that matters, but two references to *this* bus both see 1.x shapes.
 *
 * Call it before the first call goes out. A reply already parsed is already the
 * wrong shape, and this cannot reach back and change it.
 *
 * Migrating away is deleting the wrapper and fixing what the type checker or
 * `npx dbus-native lint` then points at. See docs/migrating-to-2.0.md.
 *
 * @param {object} bus a bus from sessionBus(), systemBus() or createClient()
 * @returns {object} the same bus
 */
function withClassicTypes(bus) {
  const connection = bus && bus.connection;
  if (!connection || typeof connection.setValueShapes !== 'function') {
    throw new TypeError(
      'withClassicTypes expects a bus from sessionBus(), systemBus() or createClient()'
    );
  }
  connection.setValueShapes(CLASSIC_TYPES);
  return bus;
}

module.exports = { toClassicError, withClassicTypes };
