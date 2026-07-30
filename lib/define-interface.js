// Declaring a service interface, without the positional arrays.
//
// The classic descriptor is `Echo: ['s', 's', ['input'], ['output']]` -- four
// slots whose meaning has to be memorised, in an order nothing reminds you of.
// It also has no room for anything else, which is why `access` arrived as a
// second accepted spelling for the property value and why a handler's only
// route to its caller's name is that the raw message happens to be passed after
// the arguments.
//
//     const greeter = defineInterface({
//       name: 'com.example.Greeter',
//       methods: {
//         Hello: {
//           in: { name: 's' },
//           out: { greeting: 's' },
//           handler: ({ name }, { sender }) => `Hello ${name}, from ${sender}`
//         }
//       },
//       properties: {
//         Volume: { type: 'd', get: () => volume, set: v => (volume = v) }
//       },
//       signals: { Greeted: { args: { who: 's' } } }
//     });
//
// It compiles to the classic descriptor and an impl object, so it exports
// through the same path everything else does and nothing downstream needs to
// know which spelling was used. BIG_FUTURE_PLANS 7.

const { EventEmitter } = require('events');
const {
  assertValidName,
  isValidMemberName,
  isValidPropertyName
} = require('./names');

const ACCESS = new Set(['read', 'write', 'readwrite']);
const METHOD_KEYS = new Set(['in', 'out', 'handler']);
const PROPERTY_KEYS = new Set(['type', 'access', 'get', 'set', 'value']);
const SIGNAL_KEYS = new Set(['args']);

function checkKeys(what, name, given, allowed) {
  for (const key of Object.keys(given)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${what} "${name}" has an unknown key "${key}"; expected ${[...allowed].join(', ')}`
      );
    }
  }
}

/** `{ name: 's', count: 'u' }` -> `['su', ['name', 'count']]`. */
function splitArgs(what, member, args) {
  const names = Object.keys(args || {});
  let signature = '';
  for (const name of names) {
    const type = args[name];
    if (typeof type !== 'string') {
      throw new Error(
        `${what} "${member}" argument "${name}" must be a signature string, got ${typeof type}`
      );
    }
    signature += type;
  }
  return [signature, names];
}

function defineMethod(name, spec, methods, impl) {
  if (typeof spec === 'function') spec = { handler: spec };
  if (!spec || typeof spec !== 'object') {
    throw new Error(`Method "${name}" must be an object or a function`);
  }
  checkKeys('Method', name, spec, METHOD_KEYS);
  if (typeof spec.handler !== 'function') {
    throw new Error(`Method "${name}" needs a handler function`);
  }

  const [inSignature, inNames] = splitArgs('Method', name, spec.in);
  const [outSignature, outNames] = splitArgs('Method', name, spec.out);
  methods[name] = [inSignature, outSignature, inNames, outNames];

  const handler = spec.handler;
  impl[name] = function (...args) {
    // bus.js calls a handler as `func.apply(impl, body.concat(msg))`, so the
    // message is always last. Reading it from the end rather than by declared
    // arity means a peer that sends the wrong number of arguments still gets a
    // sensible context instead of the message being mistaken for one of them.
    const msg = args[args.length - 1];
    const body = args.slice(0, -1);

    const named = {};
    for (let i = 0; i < inNames.length; i++) named[inNames[i]] = body[i];

    const context = {
      sender: msg && msg.sender,
      path: msg && msg.path,
      interface: msg && msg['interface'],
      member: msg && msg.member,
      message: msg
    };

    const result = handler.call(this, named, context);
    // Named going in, named coming back -- except for the single-value case,
    // which is what a JavaScript function naturally returns and what `invoke`
    // already hands a caller for a one-value reply. Wrapping that in an object
    // would be ceremony for the overwhelmingly common shape.
    if (outNames.length < 2) return result;
    return Promise.resolve(result).then(values => {
      if (!values || typeof values !== 'object') {
        throw new Error(
          `Method "${name}" declares ${outNames.length} return values, so it must return an object keyed by ${outNames.join(', ')}`
        );
      }
      return outNames.map(key => values[key]);
    });
  };
}

function defineProperty(name, spec, properties, impl) {
  if (typeof spec === 'string') spec = { type: spec };
  if (!spec || typeof spec !== 'object') {
    throw new Error(`Property "${name}" must be an object or a signature`);
  }
  checkKeys('Property', name, spec, PROPERTY_KEYS);
  if (typeof spec.type !== 'string') {
    throw new Error(`Property "${name}" needs a type`);
  }

  const access = spec.access === undefined ? 'readwrite' : spec.access;
  if (!ACCESS.has(access)) {
    throw new Error(
      `Property "${name}" declares access "${access}"; expected one of ${[...ACCESS].join(', ')}`
    );
  }
  if (spec.set && access === 'read') {
    throw new Error(`Property "${name}" is read-only but declares a set`);
  }
  if (spec.get && access === 'write') {
    throw new Error(`Property "${name}" is write-only but declares a get`);
  }
  if (spec.value !== undefined && (spec.get || spec.set)) {
    throw new Error(
      `Property "${name}" has both a value and an accessor; use one or the other`
    );
  }

  properties[name] = { type: spec.type, access };

  // Defined as an accessor because that is exactly how stdifaces reads and
  // writes a property: `impl[name]` and `impl[name] = value`. So a computed
  // property costs nothing extra, and a `set` still gets PropertiesChanged
  // emitted for it by the ordinary path.
  let stored = spec.value;
  Object.defineProperty(impl, name, {
    enumerable: true,
    configurable: true,
    get: spec.get ? () => spec.get() : () => stored,
    set: spec.set
      ? value => {
          spec.set(value);
        }
      : value => {
          stored = value;
        }
  });
}

function defineSignal(name, spec, signals) {
  if (!spec || typeof spec !== 'object') {
    throw new Error(`Signal "${name}" must be an object`);
  }
  checkKeys('Signal', name, spec, SIGNAL_KEYS);
  const [signature, names] = splitArgs('Signal', name, spec.args);
  signals[name] = [signature, ...names];
}

/**
 * Compile an interface definition.
 *
 * @returns {{name: string, descriptor: object, impl: object, emit: object}}
 *   `descriptor` and `impl` are what `exportInterface` takes; `emit` has one
 *   function per declared signal.
 */
function defineInterface(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('defineInterface needs a definition object');
  }
  // Checked here rather than at export: a definition is a declaration, and the
  // useful place to complain about one is where it was written.
  assertValidName('interface name', spec.name, 'the interface definition');

  const methods = {};
  const signals = {};
  const properties = {};
  // An EventEmitter because that is what `exportInterface` wraps to put a
  // signal on the bus -- it only patches `emit` if there is one to patch, so a
  // plain object would export methods and properties fine and silently never
  // emit anything.
  const impl = Object.create(EventEmitter.prototype);
  EventEmitter.call(impl);

  for (const [name, method] of Object.entries(spec.methods || {})) {
    if (!isValidMemberName(name)) {
      throw new Error(`Method "${name}" is not a valid member name`);
    }
    defineMethod(name, method, methods, impl);
  }
  for (const [name, signal] of Object.entries(spec.signals || {})) {
    if (!isValidMemberName(name)) {
      throw new Error(`Signal "${name}" is not a valid member name`);
    }
    defineSignal(name, signal, signals);
  }
  for (const [name, property] of Object.entries(spec.properties || {})) {
    // Looser than a member name on purpose: a property name is a string
    // argument to Properties.Get, never a header field, and '-' in one is the
    // GObject convention. See isValidPropertyName.
    if (!isValidPropertyName(name)) {
      throw new Error(`Property "${name}" is not a valid property name`);
    }
    defineProperty(name, property, properties, impl);
  }

  const descriptor = { name: spec.name, methods, signals, properties };

  // `exportInterface` monkey-patches `impl.emit` to put the signal on the bus,
  // so this is a named front for it -- `greeter.emit.Greeted('world')` rather
  // than a stringly-typed `impl.emit('Greeted', 'world')`.
  //
  // Emitting before export would otherwise reach EventEmitter's own `emit` and
  // do nothing at all on the bus, which is the kind of silence that costs an
  // afternoon. The patch is an *own* property while EventEmitter's is on the
  // prototype, so this tells them apart exactly.
  const emit = {};
  for (const name of Object.keys(signals)) {
    emit[name] = (...args) => {
      if (!Object.hasOwn(impl, 'emit')) {
        throw new Error(
          `Cannot emit "${name}": ${spec.name} has not been exported yet`
        );
      }
      return impl.emit(name, ...args);
    };
  }

  return { name: spec.name, descriptor, impl, emit };
}

module.exports = { defineInterface };
