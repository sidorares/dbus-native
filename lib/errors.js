/**
 * A D-Bus method call that returned an error reply.
 *
 * Since 0.7 this is what both the callback and the promise API deliver. Until
 * 0.6 the callback path received the raw message body -- an array -- which is
 * what `dbus-native/compat`'s `toClassicError()` reconstructs for code that
 * has not migrated. See docs/migrating-to-0.7.md.
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
 * Describe the call an error refers to, for the message text.
 *
 * These errors are all raised locally, so unlike an error reply there is no
 * remote message to quote -- the useful thing to say is which call it was.
 */
function describeCall(msg) {
  return `${msg.interface || '?'}.${msg.member || '?'} on ${msg.destination || '?'}`;
}

/**
 * Build a DBusError from an error reply message.
 *
 * D-Bus permits an error reply with an empty body, which is where the old
 * `err` was `[]` -- an error that rendered as nothing and told you nothing.
 * The error name is always present, so it is the fallback message.
 */
function fromReply(msg) {
  const body = msg.body || [];
  const message =
    (typeof body[0] === 'string' && body[0]) ||
    msg.errorName ||
    'D-Bus error with no message';
  return new DBusError(message, msg.errorName, body, msg);
}

/**
 * Build a DBusError from whatever the callback layer produced.
 *
 * Since 0.7 the callback layer produces a DBusError, so this is a pass-through
 * on the hot path. It still handles the 0.6 decorated-array shape, because a
 * user callback sitting between us and the promise layer may forward one.
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

/**
 * A call that was given a timeout and did not get a reply in time.
 *
 * Carries the D-Bus name the spec uses for this condition, so code that
 * switches on `dbusName` handles a local timeout and a remote NoReply the same
 * way.
 */
class TimeoutError extends DBusError {
  constructor(timeout, msg) {
    super(
      `No reply within ${timeout}ms to ${describeCall(msg)}`,
      'org.freedesktop.DBus.Error.NoReply',
      undefined,
      undefined
    );
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
    this.timeout = timeout;
  }
}

/**
 * A call cancelled through an AbortSignal.
 *
 * Uses the signal's own `reason` as the cause, so `AbortSignal.timeout()` and a
 * user's `AbortController.abort(reason)` both surface what they meant.
 */
class AbortError extends DBusError {
  constructor(signal, msg) {
    super(
      `Aborted call to ${describeCall(msg)}`,
      'org.freedesktop.DBus.Error.NoReply',
      undefined,
      undefined
    );
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
    this.cause = signal && signal.reason;
  }
}

/**
 * A call that was still in flight when the connection went away.
 *
 * Before 0.7 these callbacks were simply dropped: the socket closed, the
 * cookies went with it, and a caller waiting on a reply waited forever. That
 * is issue #39, and the reason a promise-based caller could hang a process
 * with no indication of why.
 */
class ConnectionClosedError extends DBusError {
  constructor(msg, cause) {
    super(
      `Connection closed before a reply to ${describeCall(msg)}`,
      'org.freedesktop.DBus.Error.Disconnected',
      undefined,
      undefined
    );
    this.name = 'ConnectionClosedError';
    this.code = 'ECONNCLOSED';
    // The stream error that killed the connection, when there was one. A clean
    // remote close is not an error in itself, so this is often absent.
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * A named interface that the object does not implement.
 *
 * Before 0.7 `getInterface()` for an interface missing from the introspection
 * data called back `(null, undefined)`, so the failure surfaced later as
 * "cannot read property of undefined" somewhere unrelated. That is issue #208.
 */
class UnknownInterfaceError extends DBusError {
  constructor(interfaceName, path, service, available) {
    const known =
      available && available.length
        ? ` Available: ${available.join(', ')}.`
        : '';
    super(
      `No such interface "${interfaceName}" at object path "${path}" on "${service}".${known}`,
      'org.freedesktop.DBus.Error.UnknownInterface',
      undefined,
      undefined
    );
    this.name = 'UnknownInterfaceError';
    this.interfaceName = interfaceName;
    this.path = path;
    this.service = service;
  }
}

module.exports = {
  DBusError,
  TimeoutError,
  AbortError,
  ConnectionClosedError,
  UnknownInterfaceError,
  toDBusError,
  fromReply
};
