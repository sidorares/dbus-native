/**
 * Backwards-compatibility helpers for the 0.7 error change.
 *
 * `import { toClassicError } from 'dbus-native/compat'`
 */

/**
 * The pre-0.7 error value: the error reply's body, with the properties 0.6
 * attached to it non-enumerably.
 */
export interface ClassicDBusError extends Array<unknown> {
  name: string;
  message: string;
  dbusName?: string;
  reply?: unknown;
}

/**
 * Reconstruct the pre-0.7 error value from a `DBusError`.
 *
 * Errors that came from an error reply become the body array again. Timeouts,
 * aborts and connection-closed errors never had an array form and are returned
 * unchanged.
 */
export function toClassicError(err: unknown): ClassicDBusError | unknown;
