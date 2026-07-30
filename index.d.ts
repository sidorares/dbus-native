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
// Names
// ---------------------------------------------------------------------------

/**
 * The D-Bus naming rules.
 *
 * https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names
 *
 * `exportInterface`, `sendSignal`, `sendError` and the `o` marshaller enforce
 * these on what you send. Use them directly when a name is built at runtime and
 * you would rather check than catch.
 */

/** `/`, or `/`-separated non-empty elements of `[A-Za-z0-9_]`. */
export function isValidObjectPath(path: unknown): boolean;

/** Two or more `.`-separated `[A-Za-z_][A-Za-z0-9_]*` elements, ≤ 255 bytes. */
export function isValidInterfaceName(name: unknown): boolean;

/** Error names follow the interface-name rules. */
export function isValidErrorName(name: unknown): boolean;

/** A single `[A-Za-z_][A-Za-z0-9_]*` element with no dots, ≤ 255 bytes. */
export function isValidMemberName(name: unknown): boolean;

/**
 * A member name that may also contain `-`.
 *
 * Property names are not one of the spec's name kinds -- a property name is a
 * string argument to `Properties.Get`/`Set`, never a header field -- and `-` is
 * the GObject convention, so the rule is deliberately looser than a member's.
 */
export function isValidPropertyName(name: unknown): boolean;

/** A unique name like `:1.23`, or a well-known name (which may contain `-`). */
export function isValidBusName(name: unknown): boolean;

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
  /**
   * File descriptors accompanying this message. `h` values in the body are
   * *indices* into this array, per the specification — not descriptors.
   *
   * The `UNIX_FDS` header field is derived from its length; do not set
   * `unixFds` yourself. Sending requires a transport that can carry them.
   */
  fds?: number[];
  /** How many descriptors the message declared. Derived from `fds` on send. */
  unixFds?: number;
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
   * Read 64-bit values (`x`, `t`) as native `bigint`, exactly. Default `true`
   * since 2.0.
   *
   * Set `false` for the 1.x behaviour: a `number`, which loses precision above
   * 2^53. Writing a `bigint` is accepted regardless of this option.
   */
  returnBigInt?: boolean;
  /**
   * Read the plain value shapes: a variant comes back as the value itself
   * rather than `[signatureTree, [value]]`, and a string-keyed dict as a plain
   * object rather than an array of pairs. Default `true` since 2.0; set
   * `false` for the 1.x shapes.
   *
   * Affects reading only. The marshaller accepts plain objects and `Variant`,
   * so a value read this way can be written straight back out.
   *
   * A dict whose keys are not strings (`a{us}`, `a{ts}`) stays as pairs: a
   * JavaScript object key is always a string, so converting those would change
   * the key's type and, for 64-bit keys, lose precision.
   *
   * Reading a variant this way discards its signature — set
   * `variants: 'wrap'` if you need it back.
   */
  plainValues?: boolean;
  /**
   * How a variant (`v`) comes back.
   *
   * - `'tree'` — `[parsedSignatureTree, [value]]`, what 1.x handed back
   * - `'plain'` — the value, and the signature is gone
   * - `'wrap'` — a {@link Variant}, carrying both
   *
   * Follows `plainValues` when unset, so it is `'plain'` by default and
   * `'tree'` under `plainValues: false`.
   *
   * `'wrap'` is how you ask for the type information without reading the
   * parser's internal tree: a `Variant` prints readably, `variantValue()` and
   * `toPlain()` understand it, and the marshaller accepts it, so a value read
   * this way can be sent straight back out. It is the shape to reach for when
   * a service needs to know what types an `a{sv}` argument arrived with, and
   * what `dbus-native call` uses to print `variant u 501`.
   */
  variants?: 'tree' | 'plain' | 'wrap';
  /**
   * @deprecated DBUS_DEP0001 -- 64-bit values are BigInt as of 2.0. Setting
   * this opts back out of that, and is the only reason it still does anything.
   * Note the capital R: this one option predates the rest and is the only
   * PascalCase name in the API.
   */
  ReturnLongjs?: boolean;
  /** reject a message declaring more than this many bytes; default 128 MiB */
  maxMessageSize?: number;
  /** default timeout in ms for every call on this client; default: no timeout */
  timeout?: number;
  /**
   * Reconnect when the transport goes away. **Off by default**, because
   * reconnecting changes what a connection means: the unique name is
   * reassigned, so anyone holding the old one is talking to nobody.
   *
   * `true` for the defaults, or an object to tune them. Cannot be combined
   * with `stream` — a stream the caller supplied cannot be reopened.
   *
   * Nothing in flight is retried. A method call is not idempotent, so calls
   * are failed with `ConnectionClosedError` and re-issuing is the caller's
   * decision — that is what `bus.on('reconnected')` is for.
   */
  reconnect?:
    | boolean
    | {
        /** default `Infinity` */
        retries?: number;
        /** first delay, ms; default 100 */
        minDelay?: number;
        /** ceiling, ms; default 30000 */
        maxDelay?: number;
        /** backoff multiplier; default 2 */
        factor?: number;
      };
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
  /**
   * Whether this connection's transport can carry file descriptors — i.e.
   * whether the stream implements `writeWithFds`. Nothing in this package
   * provides one; supply your own as `opts.stream`.
   */
  canPassFds: boolean;
  /** Whether the peer agreed to descriptors during the handshake. */
  unixFdsAgreed: boolean;
  /**
   * Change the value shapes this connection's parser produces. Takes effect on
   * the next message in; a reply already parsed keeps the shape it was read
   * with. `dbus-native/compat`'s `withClassicTypes` is what this is for.
   */
  setValueShapes(shapes: {
    plainValues?: boolean;
    returnBigInt?: boolean;
    ayBuffer?: boolean;
    variants?: 'tree' | 'plain' | 'wrap';
  }): this;
  /** End the transport, resolving once it is really down. */
  [Symbol.asyncDispose](): Promise<void>;

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
  /** A retry is scheduled. Only with `reconnect`. */
  on(
    event: 'reconnecting',
    listener: (info: { attempt: number; delay: number; cause?: Error }) => void
  ): this;
  /** The transport is back, before the bus has re-established anything. */
  on(event: 'reconnect', listener: () => void): this;
  /** `retries` exhausted; nothing further will be attempted. */
  on(event: 'reconnectFailed', listener: (cause?: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export function createConnection(opts?: ConnectionOptions): DBusConnection;

export interface DBusServer {
  listen(...args: any[]): unknown;
}

export function createServer(
  handler?: (conn: DBusConnection) => void
): DBusServer;

/** What the server side of the handshake learnt about a peer. */
export interface PeerIdentity {
  mechanism: string | null;
  /** the uid the peer claimed; Node cannot verify it */
  uid: number | null;
}

export interface BrokerOptions {
  /** the server GUID; generated when absent */
  guid?: string;
  /** mechanisms to offer; default ['EXTERNAL', 'DBUS_COOKIE_SHA1'] */
  authMethods?: string[];
  /** also offer ANONYMOUS, which authenticates nobody */
  anonymous?: boolean;
  /** the last word on whether to accept a peer */
  authorize?: (identity: PeerIdentity) => boolean;
  /** keyring context for DBUS_COOKIE_SHA1 */
  cookieContext?: string;
  /** ms before an unauthenticated connection is dropped; 0 waits forever */
  authTimeout?: number;
}

export interface BrokerListenOptions {
  socket?: string;
  port?: number;
  host?: string;
}

/**
 * An in-process message bus.
 *
 * Enough of one to route between clients, which `createServer` alone never
 * did. **Not** a replacement for `dbus-daemon`: no security policy, no service
 * activation, no fd passing, no eavesdropping. See docs/api.md#createbroker.
 */
export interface DBusBroker extends EventEmitter {
  listen(
    where?: BrokerListenOptions,
    cb?: (err: Error | null, address: string) => void
  ): DBusBroker;
  listen(cb: (err: Error | null, address: string) => void): DBusBroker;
  /** the address to connect to, once listening */
  address(): string | null;
  /** the names on the bus, as ListNames would report them */
  names(): string[];
  close(cb?: () => void): DBusBroker;
  readonly guid: string;
  readonly id: string;
}

export function createBroker(opts?: BrokerOptions): DBusBroker;

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
 *
 * The handler returns one value per complete type in `outputSignature`: the
 * value itself for one, an array for several, and `null` for no reply body at
 * all. Note `'(si)'` is *one* value — a struct, returned as `[name, count]` —
 * whereas `'si'` is two.
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
  /** Signals declared by the interface, as discovered by introspection. */
  $signals: Record<string, SignalDescriptor>;
  $properties: Record<string, { type: string; access?: string }>;

  $callMethod(name: string, args: unknown[]): DBusPromise<any>;
  $readProp(name: string): DBusPromise<any>;
  $readProp(name: string, callback: InvokeCallback): void;
  /**
   * Every readable property, in one `GetAll` rather than N `Get`s. Values are
   * plain whatever shape the connection reads in.
   */
  $readAllProps(): DBusPromise<Record<string, unknown>>;
  $readAllProps(callback: InvokeCallback): void;
  $writeProp(name: string, value: unknown): DBusPromise<void>;
  $writeProp(name: string, value: unknown, callback: InvokeCallback): void;

  /**
   * Subscribe, resolving once the match rule is in place.
   *
   * `on()` returns `this` and so cannot report that, nor report AddMatch
   * failing. Await this when you need the subscription live before triggering
   * whatever emits the signal.
   */
  $subscribe(
    signal: string,
    listener: (...args: any[]) => void
  ): DBusPromise<void>;
  /** Unsubscribe, resolving once the match rule has been dropped. */
  $unsubscribe(
    signal: string,
    listener: (...args: any[]) => void
  ): DBusPromise<void>;

  addListener(signal: string, listener: (...args: any[]) => void): this;
  on(signal: string, listener: (...args: any[]) => void): this;
  once(signal: string, listener: (...args: any[]) => void): this;
  removeListener(signal: string, listener: (...args: any[]) => void): this;
  off(signal: string, listener: (...args: any[]) => void): this;
  removeAllListeners(signal?: string): this;
  listenerCount(signal: string): number;

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

/** `{ path: { interfaceName: { property: value } } }`, in plain values. */
export type ManagedObjectTree = Record<
  string,
  Record<string, Record<string, unknown>>
>;

/**
 * A live view of a service's object tree, from `bus.objects()`.
 *
 * Values are plain in every connection shape — a view whose contents depended
 * on how the connection was configured would be useless to write against.
 */
export interface ManagedObjects extends EventEmitter {
  /** The bus name being watched, and the manager's path. */
  readonly service: string;
  readonly path: string;
  /** The unique name currently owning `service`. */
  readonly owner: string;
  readonly closed: boolean;

  /** The whole tree. Mutated in place as signals arrive; do not hold slices. */
  readonly objects: ManagedObjectTree;

  paths(): string[];
  get(path: string): Record<string, Record<string, unknown>> | undefined;
  /** The objects implementing an interface, as `{ path: properties }`. */
  filter(interfaceName: string): Record<string, Record<string, unknown>>;

  /** Remove the match rules and stop listening. Idempotent. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;

  on(
    event: 'added',
    listener: (
      path: string,
      interfaces: Record<string, Record<string, unknown>>
    ) => void
  ): this;
  on(
    event: 'removed',
    listener: (path: string, interfaceNames: string[]) => void
  ): this;
  on(
    event: 'changed',
    listener: (
      path: string,
      interfaceName: string,
      changed: Record<string, unknown>,
      invalidated: string[]
    ) => void
  ): this;
  /** The service was replaced or went away; this view is watching nothing. */
  on(event: 'stale', listener: (newOwner: string) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

/**
 * The property accessor on a proxy.
 *
 * A property reads as a promise; writing goes through `$set`, because
 * `obj.x = v` evaluates to `v` and a failed write would have nowhere to go.
 */
export interface ProxyProps {
  /** Every readable property, flattened across interfaces, in one call. */
  $all(): Promise<Record<string, unknown>>;
  $set(name: string, value: unknown): Promise<void>;
  $set(values: Record<string, unknown>): Promise<void>;
  [property: string]: any;
}

/**
 * A remote object, from `bus.proxy()`.
 *
 * Members resolve against what the object introspected as, so a method can be
 * called without naming its interface. Everything the proxy itself adds is
 * `$`-prefixed — a D-Bus member name is `[A-Za-z_][A-Za-z0-9_]*`, so `$` is an
 * impossible prefix rather than merely an unlikely one.
 */
export interface DBusProxy {
  readonly $bus: MessageBus;
  readonly $service: string;
  readonly $path: string;
  /** The interfaces this proxy dispatches across. */
  readonly $interfaces: string[];
  /** Child object paths, from the same introspection. */
  readonly $nodes: string[];
  readonly $props: ProxyProps;

  /** The underlying interface, for anything the proxy will not do. */
  $as(interfaceName: string): DBusInterface;

  $on(signal: string, handler: (...args: any[]) => void): this;
  $once(signal: string, handler: (...args: any[]) => void): this;
  $off(signal: string, handler: (...args: any[]) => void): this;

  /**
   * Subscribe, and get something that unsubscribes.
   *
   * The primary signal API: it resolves once the match rule is really in
   * place — which `$on` cannot report — and the subscription implements
   * `Symbol.asyncDispose`.
   */
  $watch(
    signal: string,
    handler: (...args: any[]) => void
  ): Promise<SignalSubscription>;

  /**
   * The same signal as an async iterable, for consuming in sequence.
   *
   * ```js
   * for await (const [state] of nm.$signal('StateChanged')) {
   *   if (state === CONNECTED) break; // removes the match rule
   * }
   * ```
   *
   * Bounded: `queue` is a positive integer or `'latest'`, defaulting to 64.
   * There is no unbounded option — an unbounded signal queue in a long-lived
   * process is a memory leak with a countdown.
   */
  $signal(signal: string, options?: SignalStreamOptions): SignalStream;

  /**
   * Never present, whatever the object declares — a proxy that answered `then`
   * with a function would hang every `await` on it, forever.
   */
  readonly then?: undefined;

  [member: string]: any;
}

/** What a handler is told about the call it is answering. Closes #230. */
export interface HandlerContext {
  /** The caller's unique name. */
  sender?: string;
  path?: string;
  interface?: string;
  member?: string;
  /** The whole message, for anything this does not name. */
  message?: Message;
}

/** A method, declared with named arguments rather than four positional slots. */
export interface MethodDefinition {
  /** `{ name: 's', count: 'u' }` — order is the wire order. */
  in?: Record<string, string>;
  out?: Record<string, string>;
  /**
   * Called with the arguments by name and a context.
   *
   * Return the value directly when one `out` is declared; return an object
   * keyed by the `out` names when there are several.
   */
  handler: (args: any, context: HandlerContext) => unknown;
}

export interface PropertyDefinition {
  type: string;
  /** Defaults to `readwrite`, and is enforced. */
  access?: 'read' | 'write' | 'readwrite';
  get?: () => unknown;
  /** Writing through this emits `PropertiesChanged` for you. */
  set?: (value: unknown) => void;
  /** A plain starting value, instead of `get`/`set`. */
  value?: unknown;
}

export interface InterfaceDefinition {
  name: string;
  methods?: Record<
    string,
    MethodDefinition | ((args: any, context: HandlerContext) => unknown)
  >;
  properties?: Record<string, PropertyDefinition | string>;
  signals?: Record<string, { args?: Record<string, string> }>;
}

/** What `defineInterface()` produces. */
export interface DefinedInterface {
  readonly name: string;
  /** The classic positional descriptor, for `exportInterface()`. */
  readonly descriptor: InterfaceDescriptor;
  /** The object the descriptor is bound to. */
  readonly impl: Record<string, any>;
  /** One function per declared signal. Throws before the interface is exported. */
  readonly emit: Record<string, (...args: any[]) => void>;
}

/**
 * Declare an interface without the positional arrays.
 *
 * ```js
 * const greeter = defineInterface({
 *   name: 'com.example.Greeter',
 *   methods: {
 *     Hello: {
 *       in: { name: 's' },
 *       out: { greeting: 's' },
 *       handler: ({ name }, { sender }) => `Hello ${name}, from ${sender}`
 *     }
 *   }
 * });
 * ```
 *
 * Compiles to the classic descriptor, so it exports through the same path.
 * Names, accessors and unknown keys are checked here — where the declaration
 * was written — rather than at export or on the first call.
 */
export function defineInterface(spec: InterfaceDefinition): DefinedInterface;

/** An exported interface that can be unexported, from `bus.export()`. */
export interface ExportRegistration {
  readonly path: string;
  readonly interfaceName: string;
  readonly removed: boolean;
  remove(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** A signal subscription that can be removed, from `proxy.$watch()`. */
export interface SignalSubscription {
  readonly signal: string;
  readonly removed: boolean;
  remove(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface SignalStreamOptions {
  /**
   * How many undelivered signals to hold, or `'latest'` for just the most
   * recent. Defaults to 64. There is deliberately no unbounded value.
   */
  queue?: number | 'latest';
  /** Ends the loop and removes the match rule. */
  signal?: AbortSignal;
}

export interface SignalStreamIterator extends AsyncIterableIterator<unknown[]> {
  /** How many signals were discarded because the consumer fell behind. */
  readonly dropped: number;
}

export interface SignalStream {
  [Symbol.asyncIterator](): SignalStreamIterator;
}

/** A match rule that can be removed, from `bus.watch()`. */
export interface Subscription {
  readonly rule: string;
  readonly removed: boolean;
  remove(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** A well-known name that can be released, from `bus.ownName()`. */
export interface NameRegistration {
  readonly name: string;
  /** The RequestName reply: 1 primary owner, 2 queued, 3 taken, 4 already ours. */
  readonly result: number;
  readonly isPrimaryOwner: boolean;
  readonly released: boolean;
  release(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface MessageBus extends EventEmitter {
  connection: DBusConnection;

  /**
   * Reconnected, and the unique name, owned names and match rules are back.
   * Only with `reconnect`. Nothing in flight was retried.
   */
  on(
    event: 'reconnected',
    listener: (info: { name: string; names: string[] }) => void
  ): this;
  /** Reconnected, but re-establishing the names or rules failed. */
  on(event: 'reconnectError', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;

  /** Well-known names this connection owns. Not the unique name — see `name`. */
  names: Set<string>;
  /** Match rules added through `addMatch`, replayed on a reconnect. */
  matchRules: Set<string>;
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
   * Export an interface definition, and get something that unexports it.
   *
   * ```js
   * await using reg = await bus.export('/com/example/Greeter', greeter);
   * ```
   */
  export(
    path: string,
    definition: DefinedInterface
  ): Promise<ExportRegistration>;

  /**
   * Stop serving an object, or one interface of it.
   *
   * Emits `InterfacesRemoved` if a manager is responsible for the path. An
   * object whose last interface is removed stops existing entirely, rather
   * than lingering as a path with nothing on it.
   *
   * @returns whether anything was actually removed
   */
  unexportInterface(path: string, interfaceName?: string): boolean;

  /**
   * Serve `org.freedesktop.DBus.ObjectManager` at `path`.
   *
   * It reports every object exported **strictly below** `path` — which is why
   * BlueZ puts one at `/` and reports `/org/bluez/hci0` — and emits
   * `InterfacesAdded`/`InterfacesRemoved` as objects come and go. Managers may
   * nest; the deepest one containing an object announces it, so no object is
   * announced twice.
   *
   * Opt-in rather than automatic: the interface has to appear in the
   * introspection XML for a client to know it can call `GetManagedObjects`.
   */
  exportObjectManager(path: string): this;

  /** Announce interfaces at `path`; `exportInterface` calls this for you. */
  emitInterfacesAdded(path: string, interfaceNames: string[]): void;

  /** Announce their removal; `unexportInterface` calls this for you. */
  emitInterfacesRemoved(path: string, interfaceNames: string[]): void;

  /** Paths serving `org.freedesktop.DBus.ObjectManager`. */
  objectManagers: Set<string>;

  /**
   * Close the connection, resolving once it is actually closed.
   *
   * Every in-flight call has been failed with `ConnectionClosedError` by then,
   * and writes already issued are flushed on the way out. Idempotent.
   *
   * It does not remove match rules or release names first — the bus drops both
   * when the connection goes, so unwinding them by hand would only make
   * shutdown slower. Use `watch()` and `ownName()` for resources that need to
   * end before the connection does.
   */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;

  /**
   * Add a match rule, and get something that removes it.
   *
   * ```js
   * await using sub = await bus.watch("type='signal',interface='…'");
   * ```
   *
   * This is the resource people forget: a process that adds match rules and
   * never removes them has the bus deliver steadily more traffic to it.
   */
  watch(rule: string): Promise<Subscription>;

  /**
   * Request a well-known name, and get something that releases it.
   *
   * Not getting the name is reported rather than thrown — being queued behind
   * another owner is a legitimate outcome. Check `isPrimaryOwner`.
   */
  ownName(name: string, flags?: number): Promise<NameRegistration>;

  /**
   * The remote object, as an object.
   *
   * ```js
   * const notifications = await bus.proxy(
   *   'org.freedesktop.Notifications',
   *   '/org/freedesktop/Notifications'
   * );
   * await notifications.Notify('app', 0, '', 'hi', '', [], {}, 5000);
   * await notifications.$props.$all();
   * ```
   *
   * Introspects once and resolves each member against what the object declares,
   * instead of making you name the interface first. A member declared by two
   * interfaces throws rather than being guessed at — pass `{ interface }` or
   * use `$as()`.
   */
  proxy(
    service: string,
    path: string,
    options?: { interface?: string }
  ): Promise<DBusProxy>;

  /**
   * A live view of the objects a service manages below `path`.
   *
   * One round trip for the whole tree, then kept current from
   * `InterfacesAdded`, `InterfacesRemoved` and `PropertiesChanged`.
   *
   * ```js
   * const bluez = await bus.objects('org.bluez', '/');
   * const devices = bluez.filter('org.bluez.Device1');
   * bluez.on('added', (path, interfaces) => { ... });
   * await bluez.close();
   * ```
   */
  objects(
    service: string,
    path: string,
    options?: { properties?: boolean }
  ): Promise<ManagedObjects>;

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
