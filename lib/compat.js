// The 0.7 escape hatch: turn a DBusError back into the array that the
// callback API delivered before 0.7.
//
// Deliberately a subpath (`dbus-native/compat`) rather than an option on the
// client. An option would be a mode -- invisible at the call site, inherited
// by code that never asked for it, and awkward to remove. An import is
// greppable, obviously temporary, and deleting it is one line.
//
// See docs/migrating-to-0.7.md.

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

module.exports = { toClassicError };
