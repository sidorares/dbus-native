// jscodeshift transform: the callback `err` became a DBusError in 0.7.
//
//   err[0]                -> err.message
//   err[1], err[2], ...   -> err.body[1], err.body[2], ...
//   new Error(err[0])     -> err
//   const [a, b] = err    -> const [a, b] = err.body
//
// The hard part is not the rewrite, it is knowing which `err` is ours. An
// index chain on an arbitrary variable called `err` could be anything, and a
// codemod that guesses wrong in an error path is worse than one that does
// nothing. So this only rewrites inside callbacks it can identify as d-bus
// callbacks from the shape of the call site, and *reports* everything else it
// suspects rather than touching it.
//
// See docs/migrating-to-0.7.md.

// Methods on a bus, service or object whose last argument is an (err, ...)
// callback. A call to any of these is proof enough.
const BUS_METHODS = new Set([
  'invoke',
  'invokeDbus',
  'getObject',
  'getInterface',
  'addMatch',
  'removeMatch',
  'getId',
  'requestName',
  'releaseName',
  'listNames',
  'listActivatableNames',
  'updateActivationEnvironment',
  'startServiceByName',
  'getConnectionUnixUser',
  'getConnectionUnixProcessId',
  'getNameOwner',
  'nameHasOwner',
  // proxy interface property access
  '$readProp',
  '$writeProp'
]);

// Names people give the first callback parameter. Used only for *reporting*
// suspicious sites, never for rewriting.
const ERROR_PARAM_NAMES = new Set(['err', 'error', 'e']);

const isFunction = node =>
  node &&
  (node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression');

/** `bus.invoke(...)` / `service.getInterface(...)` -- a call we recognise. */
function isDbusCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type === 'MemberExpression' && !callee.computed) {
    return (
      callee.property.type === 'Identifier' &&
      BUS_METHODS.has(callee.property.name)
    );
  }
  return false;
}

/**
 * The callbacks we are confident about: a function argument to a recognised
 * d-bus call, whose first parameter is a plain identifier.
 */
function findDbusCallbacks(j, root) {
  const found = [];
  root.find(j.CallExpression).forEach(path => {
    if (!isDbusCall(path.node)) return;
    for (const arg of path.node.arguments) {
      if (!isFunction(arg)) continue;
      const [first] = arg.params;
      if (!first || first.type !== 'Identifier') continue;
      found.push({
        fnPath: path.get('arguments', path.node.arguments.indexOf(arg)),
        name: first.name
      });
    }
  });
  return found;
}

/**
 * Is this identifier the callback's own `err`, or a different binding that
 * happens to share the name?
 *
 * Without this a nested `function (err) {...}` inside the callback -- entirely
 * plausible, since d-bus code nests calls -- would have its own unrelated
 * `err[0]` rewritten.
 */
function bindsToCallback(path, name, fnPath) {
  const scope = path.scope && path.scope.lookup(name);
  if (!scope) return false;
  // The binding must be the callback's own parameter scope.
  return scope.path === fnPath;
}

module.exports = function transform(fileInfo, api, options) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);
  let changed = false;

  const rewritten = new Set();

  for (const { fnPath, name } of findDbusCallbacks(j, root)) {
    const body = j(fnPath);

    // `new Error(err[0])` -> `err`. Done first so the whole expression goes,
    // rather than leaving `new Error(err.message)`.
    body
      .find(j.NewExpression, {
        callee: { type: 'Identifier', name: 'Error' }
      })
      .forEach(path => {
        const [arg] = path.node.arguments;
        if (
          path.node.arguments.length !== 1 ||
          !arg ||
          arg.type !== 'MemberExpression' ||
          !arg.computed ||
          arg.object.type !== 'Identifier' ||
          arg.object.name !== name ||
          arg.property.type !== 'Literal' ||
          arg.property.value !== 0
        )
          return;
        if (!bindsToCallback(path.get('arguments', 0, 'object'), name, fnPath))
          return;
        rewritten.add(arg);
        j(path).replaceWith(j.identifier(name));
        changed = true;
      });

    // `err[0]` -> `err.message`, `err[n]` -> `err.body[n]`
    body
      .find(j.MemberExpression, {
        computed: true,
        object: { type: 'Identifier', name }
      })
      .forEach(path => {
        if (rewritten.has(path.node)) return;
        const prop = path.node.property;
        if (prop.type !== 'Literal' || typeof prop.value !== 'number') return;
        if (!bindsToCallback(path.get('object'), name, fnPath)) return;

        if (prop.value === 0) {
          j(path).replaceWith(
            j.memberExpression(j.identifier(name), j.identifier('message'))
          );
        } else {
          j(path).replaceWith(
            j.memberExpression(
              j.memberExpression(j.identifier(name), j.identifier('body')),
              j.literal(prop.value),
              true
            )
          );
        }
        changed = true;
      });

    // `const [text, code] = err` -> `... = err.body`
    body
      .find(j.VariableDeclarator, {
        id: { type: 'ArrayPattern' },
        init: { type: 'Identifier', name }
      })
      .forEach(path => {
        if (!bindsToCallback(path.get('init'), name, fnPath)) return;
        j(path.get('init')).replaceWith(
          j.memberExpression(j.identifier(name), j.identifier('body'))
        );
        changed = true;
      });
  }

  // Report, do not rewrite: an index into something that looks like an error
  // but is not reachable from a call site we recognise. Proxy method calls
  // (`iface.Echo(x, cb)`) land here, because the member name is the remote
  // method and could be anything.
  const suspicious = [];
  root.find(j.MemberExpression, { computed: true }).forEach(path => {
    const { object, property } = path.node;
    if (object.type !== 'Identifier') return;
    if (!ERROR_PARAM_NAMES.has(object.name)) return;
    if (property.type !== 'Literal' || typeof property.value !== 'number')
      return;
    suspicious.push({
      line: path.node.loc ? path.node.loc.start.line : 0,
      text: `${object.name}[${property.value}]`
    });
  });

  if (suspicious.length && !(options && options.quiet)) {
    for (const s of suspicious) {
      console.warn(
        `${fileInfo.path}:${s.line}  DBUS_DEP0004  ${s.text} on an error this codemod could not attribute to a d-bus call -- review by hand`
      );
    }
  }

  return changed ? root.toSource() : null;
};

module.exports.parser = 'babel';
