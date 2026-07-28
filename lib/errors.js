/**
 * A D-Bus method call that returned an error reply.
 *
 * The callback API still receives the raw message body (an array) until 1.0,
 * for compatibility -- see docs/deprecations.md#dbus_dep0004. The promise API
 * is new in 0.6, so nothing depends on the old shape there and it rejects with
 * a real Error from the start.
 */
class DBusError extends Error {
  constructor(message, dbusName, body, reply) {
    super(message);
    this.name = 'DBusError';
    /** The D-Bus error name, e.g. 'org.freedesktop.DBus.Error.ServiceUnknown' */
    this.dbusName = dbusName;
    /** The raw message body, for the rare caller that wants the arguments */
    this.body = body;
    /** The full reply message */
    this.reply = reply;
  }
}

/**
 * Build a DBusError from whatever the callback layer produced.
 *
 * In 0.6 that is the message body array carrying non-enumerable `message`,
 * `dbusName` and `reply` properties; in 1.0 it will already be a DBusError and
 * this becomes a pass-through.
 */
function toDBusError(err) {
  if (err instanceof DBusError) return err;
  if (err instanceof Error) return err;
  const body = Array.isArray(err) ? Array.from(err) : err;
  const message =
    (err && err.message) ||
    (Array.isArray(err) && typeof err[0] === 'string' && err[0]) ||
    (err && err.dbusName) ||
    'D-Bus error with no message';
  return new DBusError(message, err && err.dbusName, body, err && err.reply);
}

module.exports = { DBusError, toDBusError };
