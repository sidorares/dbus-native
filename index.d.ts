// Type definitions for dbus-native
//
// Hand-written and checked in CI against test/types/usage.ts, so they cannot
// drift from the implementation without the build failing.
//
// Note the value shapes here describe the *current* API. The 2.0 type-system
// change is documented in docs/deprecations.md and RELEASE_PLAN.md; the
// forward-compatible helpers (variantValue, toPlain, Variant) are typed to
// accept both shapes so code written against them keeps type-checking.

/// <reference types="node" />

import { EventEmitter } from 'events';
import { Duplex } from 'stream';

/**
 * What a call returns when no callback is given.
 *
 * Deliberately not a `Promise`. Calling without a callback has always meant
 * fire-and-forget, so the underlying promise is only constructed once someone
 * observes the result -- ignoring it must not turn a dropped failure into an
 * unhandled rejection. `await`, `Promise.all`, `.catch` and `.finally` all
 * work; `instanceof Promise` does not.
 */
export interface DBusPromise<T> extends PromiseLike<T> {
  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: DBusError) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2>;
  catch<R = never>(
    onrejected?: ((reason: DBusError) => R | PromiseLike<R>) | null
  ): Promise<T | R>;
  finally(onfinally?: (() => void) | null): Promise<T>;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A node of a parsed d-bus signature. */
export interface SignatureNode {
  type: string;
  child: SignatureNode[];
}

/**
 * A variant as it is unmarshalled today: the parsed signature, then a
 * one-element array holding the value. Changes in 2.0 -- read it with
 * `variantValue()` rather than by index.
 */
export type ClassicVariant = [SignatureNode[], unknown[]];

/** Any value that came off the wire. */
export type DBusValue = unknown;

/**
 * An explicitly typed value. Accepted by the marshaller anywhere a
 * `[signature, value]` pair is, and the forward-compatible way to write a
 * variant.
 */
export class Variant<T = unknown> {
  constructor(signature: string, value: T);
  signature: string;
  value: T;
}

/**
 * Read the value out of a variant, in either the current or the 2.0 shape.
 * Returns the argument unchanged if it is already a plain value.
 */
export function variantValue<T = unknown>(value: unknown): T;

/** The signature of a variant, or undefined once the value has been flattened. */
export function variantSignature(value: unknown): string | undefined;

/**
 * Recursively convert to plain JavaScript: dicts become objects, variants are
 * unwrapped. A no-op on values that are already plain.
 */
export function toPlain<T = unknown>(value: unknown): T;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A method call that returned an error reply. */
export class DBusError extends Error {
  name: string;
  /** e.g. 'org.freedesktop.DBus.Error.ServiceUnknown' */
  dbusName?: string;
  /** the raw reply body */
  body?: unknown;
  /** the full reply message */
  reply?: Message;
}

/** A call given a timeout that did not get a reply in time. */
export class TimeoutError extends DBusError {
  code: 'ETIMEDOUT';
  timeout: number;
}

/** A call cancelled through an AbortSignal. `cause` is the signal's reason. */
export class AbortError extends DBusError {
  code: 'ABORT_ERR';
}

/**
 * A call still in flight when the connection went away. Before 0.7 these
 * callbacks were dropped and the caller waited forever.
 */
export class ConnectionClosedError extends DBusError {
  code: 'ECONNCLOSED';
}

/**
 * A named interface the object does not implement. Before 0.7 `getInterface()`
 * called back `(null, undefined)` instead.
 */
export class UnknownInterfaceError extends DBusError {
  interfaceName: string;
  path: string;
  service?: string;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface MessageType {
  invalid: 0;
  methodCall: 1;
  methodReturn: 2;
  error: 3;
  signal: 4;
}

export const messageType: MessageType;

export interface Message {
  type?: number;
  flags?: number;
  serial?: number;
  path?: string;
  interface?: string;
  member?: string;
  errorName?: string;
  replySerial?: number;
  destination?: string;
  sender?: string;
  signature?: string;
  body?: unknown[];
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export interface ConnectionOptions {
  /** an already-connected duplex stream to use instead of dialling */
  stream?: Duplex;
  /** unix socket path */
  socket?: string;
  /** TCP port */
  port?: number;
  /** TCP host */
  host?: string;
  /** encoded bus address; defaults to $DBUS_SESSION_BUS_ADDRESS */
  busAddress?: string;
  /** attempted in order; default ['EXTERNAL', 'DBUS_COOKIE_SHA1', 'ANONYMOUS'] */
  authMethods?: string[];
  /** act as the server side of the handshake */
  server?: boolean;
  /** skip the initial Hello, for peer-to-peer connections */
  direct?: boolean;
  /**
   * How `ay` fields are returned. `true` (default) copies into a Buffer,
   * `'view'` shares memory with the message, `false` gives an array of numbers.
   */
  ayBuffer?: boolean | 'view';
  /**
   * Read 64-bit values (`x`, `t`) as native `bigint`, exactly, instead of a
   * `number` that loses precision above 2^53. This is what they become by
   * default in 2.0 — opting in now means no change then.
   *
   * Wins over `ReturnLongjs` if both are set. Writing a `bigint` is accepted
   * regardless of this option.
   */
  returnBigInt?: boolean;
  /**
   * @deprecated DBUS_DEP0001 -- 64-bit values become BigInt in 2.0; use
   * `returnBigInt`. Note the capital R: this one option predates the rest and
   * is the only PascalCase name in the API. It cannot be corrected without
   * breaking the callers who set it.
   */
  ReturnLongjs?: boolean;
  /** reject a message declaring more than this many bytes; default 128 MiB */
  maxMessageSize?: number;
  /** default timeout in ms for every call on this client; default: no timeout */
  timeout?: number;
}

export interface DBusConnection extends EventEmitter {
  stream: Duplex;
  guid?: string;
  state?: string;
  /**
   * Write a message. Returns false when the socket's buffer is full, following
   * the `stream.write()` convention; wait for 'drain' before continuing.
   */
  message(msg: Message): boolean;
  end(): this;

  on(event: 'connect', listener: () => void): this;
  on(event: 'message', listener: (msg: Message) => void): this;
  on(event: 'drain', listener: () => void): this;
  on(event: 'end', listener: () => void): this;
  /**
   * The transport is fully torn down, however that happened. Pending calls
   * have been failed with ConnectionClosedError by the time this fires.
   */
  on(event: 'close', listener: (cause?: Error) => void): this;
  /** transport or protocol failure; the connection is destroyed after a protocol error */
  on(event: 'error', listener: (err: Error) => void): this;
  /** an exception thrown by one of your own message/signal listeners */
  on(event: 'handlerError', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export function createConnection(opts?: ConnectionOptions): DBusConnection;

export interface DBusServer {
  listen(...args: any[]): unknown;
}

export function createServer(
  handler?: (conn: DBusConnection) => void
): DBusServer;

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export interface CallOptions {
  /** cancel the call; rejects with AbortError */
  signal?: AbortSignal;
  /** ms to wait for a reply; 0 disables. Defaults to the client's timeout */
  timeout?: number;
}

/**
 * Called with the reply. Since 0.7 `err` is a `DBusError`; before it was the
 * raw body array. See docs/migrating-to-0.7.md.
 */
export type InvokeCallback = (err: DBusError | null, ...values: any[]) => void;

// ---------------------------------------------------------------------------
// Interfaces and services
// ---------------------------------------------------------------------------

/**
 * A method as declared in an interface descriptor:
 * [inputSignature, outputSignature, inputNames, outputNames]
 */
export type MethodDescriptor = [string, string, string[], string[]];

/** A signal: [signature, ...argumentNames] */
export type SignalDescriptor = string[];

/** How a property may be used. Defaults to 'readwrite'. */
export type PropertyAccess = 'read' | 'write' | 'readwrite';

/**
 * A property: a signature, or a signature plus its access.
 *
 * The bare-string form means `readwrite`, which is what it always meant.
 */
export type PropertyDescriptor =
  string | { type: string; access?: PropertyAccess };

export interface InterfaceDescriptor {
  name: string;
  methods?: Record<string, MethodDescriptor>;
  signals?: Record<string, SignalDescriptor>;
  properties?: Record<string, PropertyDescriptor>;
}

/**
 * A proxy for a remote interface. Members discovered by introspection are
 * added dynamically, so they are typed loosely here; pass a shape to
 * `getInterface<T>()` for a checked surface.
 */
export interface DBusInterface {
  $name: string;
  $parent: DBusObject;
  $methods: Record<string, string>;
  $properties: Record<string, { type: string; access?: string }>;

  $callMethod(name: string, args: unknown[]): DBusPromise<any>;
  $readProp(name: string): DBusPromise<any>;
  $readProp(name: string, callback: InvokeCallback): void;
  $writeProp(name: string, value: unknown): DBusPromise<void>;
  $writeProp(name: string, value: unknown, callback: InvokeCallback): void;

  addListener(signal: string, listener: (...args: any[]) => void): void;
  on(signal: string, listener: (...args: any[]) => void): void;
  removeListener(signal: string, listener: (...args: any[]) => void): void;
  off(signal: string, listener: (...args: any[]) => void): void;

  [member: string]: any;
}

export interface DBusObject {
  name: string;
  service: DBusService;
  proxy: Record<string, DBusInterface>;
  nodes?: string[];
  /** @throws {UnknownInterfaceError} if the object does not implement it */
  as(interfaceName: string): DBusInterface;
}

export interface DBusService {
  name: string;
  bus: MessageBus;

  getObject(path: string): DBusPromise<DBusObject>;
  getObject(path: string, callback: (err: any, obj: DBusObject) => void): void;

  getInterface<T = DBusInterface>(
    path: string,
    interfaceName: string
  ): DBusPromise<T & DBusInterface>;
  getInterface<T = DBusInterface>(
    path: string,
    interfaceName: string,
    callback: (err: any, iface: T & DBusInterface) => void
  ): void;
}

// ---------------------------------------------------------------------------
// The bus
// ---------------------------------------------------------------------------

export interface MessageBus {
  connection: DBusConnection;
  serial: number;
  cookies: Record<number, InvokeCallback>;
  signals: EventEmitter;
  exportedObjects: Record<string, Record<string, [InterfaceDescriptor, any]>>;
  name?: string;

  invoke<T = any>(msg: Message, options?: CallOptions): DBusPromise<T>;
  invoke(msg: Message, callback: InvokeCallback): void;
  invoke(msg: Message, options: CallOptions, callback: InvokeCallback): void;

  invokeDbus<T = any>(msg: Message, options?: CallOptions): DBusPromise<T>;
  invokeDbus(msg: Message, callback: InvokeCallback): void;
  invokeDbus(
    msg: Message,
    options: CallOptions,
    callback: InvokeCallback
  ): void;

  /** Build the key used for `bus.signals` events. */
  mangle(path: string, iface: string, member: string): string;
  mangle(msg: Message): string;

  sendSignal(
    path: string,
    iface: string,
    name: string,
    signature?: string,
    args?: unknown[]
  ): void;
  sendError(msg: Message, errorName: string, errorText: string): void;
  sendReply(msg: Message, signature: string, body: unknown[]): void;

  setMethodCallHandler(
    objectPath: string,
    iface: string,
    member: string,
    handler: [(...args: any[]) => any, string]
  ): void;
  exportInterface(obj: unknown, path: string, iface: InterfaceDescriptor): void;

  /**
   * Emit org.freedesktop.DBus.Properties.PropertiesChanged for an exported
   * interface.
   *
   * `Properties.Set` does this for you. Call it when the service changes a
   * property itself — an ordinary assignment cannot be observed.
   *
   * `invalidated` names properties whose value changed but is not being sent,
   * telling subscribers to re-read rather than keep a stale value.
   *
   * @throws if the interface is not exported at `path`, or a named property is
   * not declared on it
   */
  emitPropertiesChanged(
    path: string,
    interfaceName: string,
    changed: Record<string, unknown>,
    invalidated?: string[]
  ): void;

  getService(name: string): DBusService;

  getObject(service: string, path: string): DBusPromise<DBusObject>;
  getObject(
    service: string,
    path: string,
    callback: (err: any, obj: DBusObject) => void
  ): void;

  getInterface<T = DBusInterface>(
    service: string,
    path: string,
    interfaceName: string
  ): DBusPromise<T & DBusInterface>;
  getInterface<T = DBusInterface>(
    service: string,
    path: string,
    interfaceName: string,
    callback: (err: any, iface: T & DBusInterface) => void
  ): void;

  addMatch(match: string): DBusPromise<void>;
  addMatch(match: string, callback: InvokeCallback): void;
  removeMatch(match: string): DBusPromise<void>;
  removeMatch(match: string, callback: InvokeCallback): void;

  getId(): DBusPromise<string>;
  getId(callback: (err: any, id: string) => void): void;

  requestName(name: string, flags: number): DBusPromise<number>;
  requestName(
    name: string,
    flags: number,
    callback: (err: any, result: number) => void
  ): void;

  releaseName(name: string): DBusPromise<number>;
  releaseName(name: string, callback: (err: any, result: number) => void): void;

  listNames(): DBusPromise<string[]>;
  listNames(callback: (err: any, names: string[]) => void): void;

  listActivatableNames(): DBusPromise<string[]>;
  listActivatableNames(callback: (err: any, names: string[]) => void): void;

  updateActivationEnvironment(env: Record<string, string>): DBusPromise<void>;
  updateActivationEnvironment(
    env: Record<string, string>,
    callback: InvokeCallback
  ): void;

  startServiceByName(name: string, flags: number): DBusPromise<number>;
  startServiceByName(
    name: string,
    flags: number,
    callback: (err: any, result: number) => void
  ): void;

  getConnectionUnixUser(name: string): DBusPromise<number>;
  getConnectionUnixUser(
    name: string,
    callback: (err: any, uid: number) => void
  ): void;

  getConnectionUnixProcessId(name: string): DBusPromise<number>;
  getConnectionUnixProcessId(
    name: string,
    callback: (err: any, pid: number) => void
  ): void;

  getNameOwner(name: string): DBusPromise<string>;
  getNameOwner(name: string, callback: (err: any, owner: string) => void): void;

  nameHasOwner(name: string): DBusPromise<boolean>;
  nameHasOwner(
    name: string,
    callback: (err: any, hasOwner: boolean) => void
  ): void;
}

export function createClient(opts?: ConnectionOptions): MessageBus;
export function sessionBus(opts?: ConnectionOptions): MessageBus;
export function systemBus(): MessageBus;
