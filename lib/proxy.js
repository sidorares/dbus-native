// bus.proxy(): the remote object, as an object.
//
//     const notifications = await bus.proxy(
//       'org.freedesktop.Notifications',
//       '/org/freedesktop/Notifications'
//     );
//     const id = await notifications.Notify('app', 0, '', 'hi', '', [], {}, 5000);
//
// The existing surface makes you name the interface before you can call
// anything -- getService().getInterface(path, iface) -- which means knowing
// which of an object's interfaces a member lives on before you can use it.
// Almost nobody does; they look it up once and hard-code it. This resolves the
// member against what the object actually introspected as.
//
// BIG_FUTURE_PLANS 2, with the correction from 2.3.

const util = require('util');
const { signalStream } = require('./signal-stream');

/**
 * Names the proxy must never manufacture a method for.
 *
 * `then` is the one that matters. `await` looks up `.then`, finds a function,
 * calls it with (resolve, reject) and waits forever for a resolve that never
 * comes -- so the program hangs with no error and no stack.
 *
 * And it hangs *immediately*, not at first use: `bus.proxy()` is async, so
 * returning the proxy from it awaits it on the caller's behalf. Measured by
 * emptying this set and running the suite -- every one of the 23 tests
 * cancelled, none even reached, because the `before` hook never returned. That
 * is a worse failure than a wrong answer, and it is one line away.
 *
 * A service is free to have a member genuinely called `then`, so this is
 * checked before the member table rather than after. Reach it with `$as()`.
 */
const NEVER_A_MEMBER = new Set(['then']);

/** Build `member -> [interfaceName, ...]` across every interface on an object. */
function index(interfaces, kind) {
  const byMember = new Map();
  for (const [interfaceName, iface] of Object.entries(interfaces)) {
    for (const member of Object.keys(iface[kind] || {})) {
      if (!byMember.has(member)) byMember.set(member, []);
      byMember.get(member).push(interfaceName);
    }
  }
  return byMember;
}

/**
 * Resolve a member to exactly one interface.
 *
 * Ambiguity throws rather than picking: two interfaces on one object really can
 * declare the same member name, and guessing would send the call to whichever
 * happened to introspect first. The error names both so the fix is obvious.
 */
function resolve(byMember, member, kind, path) {
  const found = byMember.get(member);
  if (!found) return undefined;
  if (found.length > 1) {
    throw new Error(
      `${kind} "${member}" is declared by more than one interface at ${path}: ` +
        `${found.join(', ')}. Name one with bus.proxy(..., { interface }) or $as().`
    );
  }
  return found[0];
}

/** The `$props` accessor: a property reads as a promise of its value. */
function makeProps(interfaces, byProperty, path, only) {
  const target = {
    /**
     * Every readable property, flattened across interfaces.
     *
     * Flat rather than grouped by interface because that is how people think
     * about an object's properties, and because grouping would make the common
     * case -- one interface -- noisier for no gain.
     */
    $all: async () => {
      const out = {};
      for (const [interfaceName, iface] of Object.entries(interfaces)) {
        if (only && interfaceName !== only) continue;
        if (!Object.keys(iface.$properties || {}).length) continue;
        Object.assign(out, await iface.$readAllProps());
      }
      return out;
    },

    /** `$set(name, value)` or `$set({ name: value, ... })`. */
    $set: async (nameOrValues, maybeValue) => {
      const values =
        typeof nameOrValues === 'string'
          ? { [nameOrValues]: maybeValue }
          : nameOrValues;
      for (const [name, value] of Object.entries(values)) {
        const interfaceName = resolve(byProperty, name, 'Property', path);
        if (interfaceName === undefined) {
          throw new Error(`No property "${name}" at ${path}`);
        }
        await interfaces[interfaceName].$writeProp(name, value);
      }
    }
  };

  return new Proxy(target, {
    get(t, key) {
      if (typeof key !== 'string' || Object.hasOwn(t, key)) {
        return Reflect.get(t, key);
      }
      if (NEVER_A_MEMBER.has(key)) return undefined;
      const interfaceName = resolve(byProperty, key, 'Property', path);
      if (interfaceName === undefined) return undefined;
      // A getter that returns a promise, so `await proxy.$props.Volume` reads
      // like a property access and still surfaces failures.
      return interfaces[interfaceName].$readProp(key);
    },
    has(t, key) {
      return Object.hasOwn(t, key) || byProperty.has(key);
    },
    ownKeys(t) {
      return [...new Set([...Reflect.ownKeys(t), ...byProperty.keys()])];
    },
    getOwnPropertyDescriptor(t, key) {
      if (Object.hasOwn(t, key))
        return Reflect.getOwnPropertyDescriptor(t, key);
      if (byProperty.has(key)) {
        return { configurable: true, enumerable: true, value: undefined };
      }
      return undefined;
    },
    set() {
      // `obj.x = v` evaluates to `v`, not to a promise, so a failed write would
      // be silently lost. Refusing is the one place asymmetry beats a footgun.
      throw new Error(
        'Assigning to a property cannot report failure. Use $props.$set(name, value).'
      );
    }
  });
}

/**
 * Build the proxy for an already-introspected object.
 *
 * @param {object} obj a DBusObject from bus.getObject()
 * @param {{interface?: string}} options restrict every lookup to one interface
 */
function createProxy(obj, options = {}) {
  const all = obj.proxy || {};
  const only = options.interface;
  if (only !== undefined && !Object.hasOwn(all, only)) {
    const names = Object.keys(all);
    throw new Error(
      `No interface "${only}" at ${obj.name}. ${
        names.length ? `Available: ${names.join(', ')}` : 'It has none.'
      }`
    );
  }
  const interfaces = only ? { [only]: all[only] } : all;
  const path = obj.name;

  const byMethod = index(interfaces, '$methods');
  const byProperty = index(interfaces, '$properties');
  const bySignal = index(interfaces, '$signals');

  /** The one interface declaring this signal, or a thrown explanation. */
  const signalInterface = signal => {
    const interfaceName = resolve(bySignal, signal, 'Signal', path);
    if (interfaceName === undefined) {
      throw new Error(`No signal "${signal}" at ${path}`);
    }
    return interfaceName;
  };

  const target = {
    $bus: obj.service.bus,
    $service: obj.service.name,
    $path: path,
    /** The interfaces this proxy dispatches across. */
    $interfaces: Object.keys(interfaces),
    /** Child object paths, from the same introspection. */
    $nodes: obj.nodes || [],

    /** The underlying interface, for anything this proxy will not do. */
    $as(interfaceName) {
      const iface = all[interfaceName];
      if (!iface) {
        throw new Error(
          `No interface "${interfaceName}" at ${path}. ` +
            `Available: ${Object.keys(all).join(', ') || 'none'}`
        );
      }
      return iface;
    },

    /** Subscribe to a signal, wherever it is declared. */
    $on(signal, handler) {
      const interfaceName = resolve(bySignal, signal, 'Signal', path);
      if (interfaceName === undefined) {
        throw new Error(`No signal "${signal}" at ${path}`);
      }
      interfaces[interfaceName].on(signal, handler);
      return target;
    },

    $once(signal, handler) {
      const interfaceName = resolve(bySignal, signal, 'Signal', path);
      if (interfaceName === undefined) {
        throw new Error(`No signal "${signal}" at ${path}`);
      }
      interfaces[interfaceName].once(signal, handler);
      return target;
    },

    $off(signal, handler) {
      const interfaceName = resolve(bySignal, signal, 'Signal', path);
      if (interfaceName === undefined) return target;
      interfaces[interfaceName].off(signal, handler);
      return target;
    },

    /**
     * Subscribe, and get something that unsubscribes.
     *
     * The primary signal API. Resolves once the match rule is actually in
     * place, which `$on` cannot report, and the subscription implements
     * `Symbol.asyncDispose` so leaving a scope releases it.
     */
    async $watch(signal, handler) {
      const iface = interfaces[signalInterface(signal)];
      await iface.$subscribe(signal, handler);
      let removed = false;
      const subscription = {
        signal,
        get removed() {
          return removed;
        },
        async remove() {
          if (removed) return;
          removed = true;
          await iface.$unsubscribe(signal, handler);
        },
        async [Symbol.asyncDispose]() {
          await subscription.remove();
        }
      };
      return subscription;
    },

    /**
     * The same signal as an async iterable, for consuming in sequence.
     *
     *     for await (const [state] of nm.$signal('StateChanged')) {
     *       if (state === CONNECTED) break; // removes the match rule
     *     }
     *
     * Bounded: `queue` is a positive integer or `'latest'`, never unbounded.
     * See lib/signal-stream.js for why, and `stream.dropped` for how many were
     * discarded when the consumer fell behind.
     */
    $signal(signal, options) {
      const interfaceName = signalInterface(signal);
      return signalStream(async handler => {
        // The stream hands us one argument per signal body; the interface
        // emits them spread, so they are collected back into the array a
        // `for await (const [a, b] of ...)` destructures.
        const listener = (...args) => handler(args);
        await interfaces[interfaceName].$subscribe(signal, listener);
        return {
          remove: () => interfaces[interfaceName].$unsubscribe(signal, listener)
        };
      }, options);
    }
  };

  target.$props = makeProps(interfaces, byProperty, path, only);

  // Without this, `console.log(proxy)` prints `$bus` and walks the whole
  // connection -- an EventEmitter, a socket, every pending call. What a reader
  // wants is which object this is and what it can do, which is the same
  // argument that earned Variant a custom inspect.
  target[util.inspect.custom] = (depth, opts) => {
    const members = [...byMethod.keys()].sort();
    const props = [...byProperty.keys()].sort();
    const sigs = [...bySignal.keys()].sort();
    const line = (label, xs) =>
      xs.length ? `\n  ${label}: ${xs.join(', ')}` : '';
    return `DBusProxy ${opts.stylize(obj.service.name, 'string')} ${opts.stylize(path, 'string')}${line(
      'methods',
      members
    )}${line('properties', props)}${line('signals', sigs)}`;
  };

  return new Proxy(target, {
    get(t, key, receiver) {
      // Symbols are never D-Bus member names -- `util.inspect.custom`,
      // `Symbol.toStringTag`, `Symbol.iterator` -- so they pass through
      // untouched rather than being answered with a manufactured method.
      if (typeof key !== 'string') return Reflect.get(t, key, receiver);
      if (Object.hasOwn(t, key)) return Reflect.get(t, key, receiver);
      if (NEVER_A_MEMBER.has(key)) return undefined;

      const interfaceName = resolve(byMethod, key, 'Method', path);
      if (interfaceName !== undefined) {
        const iface = interfaces[interfaceName];
        return (...args) => iface[key](...args);
      }
      // Not a method, and not something this proxy adds. Left undefined rather
      // than thrown so `key in proxy`, `typeof proxy.X` and feature checks all
      // behave; a call then fails as "is not a function", which is the usual
      // JavaScript answer to a name that is not there.
      return undefined;
    },
    has(t, key) {
      return (
        Object.hasOwn(t, key) || (typeof key === 'string' && byMethod.has(key))
      );
    },
    ownKeys(t) {
      return [...new Set([...Reflect.ownKeys(t), ...byMethod.keys()])];
    },
    getOwnPropertyDescriptor(t, key) {
      if (Object.hasOwn(t, key))
        return Reflect.getOwnPropertyDescriptor(t, key);
      if (typeof key === 'string' && byMethod.has(key)) {
        return { configurable: true, enumerable: true, value: undefined };
      }
      return undefined;
    },
    set(t, key) {
      throw new Error(
        `Cannot assign to "${String(key)}" on a proxy. Use $props.$set() for properties.`
      );
    }
  });
}

module.exports = { createProxy, NEVER_A_MEMBER };
