/**
 * Escape hatches for code that cannot be migrated yet.
 *
 * `import { toClassicError, withClassicTypes } from 'dbus-native/compat'`
 */

import type { MessageBus } from '../index';

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

/**
 * Read classic value shapes on a 0.14.0 connection: a variant as
 * `[signatureTree, [value]]`, a string-keyed dict as an array of pairs, and
 * `x`/`t` as a lossy `number`.
 *
 * Configures the connection it is given and returns the same bus. Call it
 * before the first call goes out.
 */
export function withClassicTypes<T extends MessageBus>(bus: T): T;
