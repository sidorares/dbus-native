// jscodeshift transform: find reads of the value shapes that changed in 0.14.0.
//
// This is a *linter*, not a codemod -- it never modifies a file. Reading a
// variant is `result[1][1][0]`, an index chain a codemod cannot safely rewrite
// because it has no idea what the value is. So we flag rather than transform,
// and narrow the problem to a reviewed list of call sites.
//
// Findings go to stdout as one JSON line each, prefixed with a marker, because
// jscodeshift owns the rest of the output and runs transforms in worker
// processes. bin/dbus-native.js picks them back out and formats the report.
//
// See docs/deprecations.md and RELEASE_PLAN.md.

const MARKER = '##DBUS_LINT##';

// `Object.entries(x)` and friends produce the same `[key, value]` pairs a
// d-bus dict does. Iterating one of those is ordinary JavaScript, not a
// deprecated read, so the pair rule steps around them.
const PAIR_SOURCES = new Set([
  'entries',
  'keys',
  'values',
  'items',
  'getOwnPropertyEntries'
]);

const RULES = {
  DBUS_DEP0001: 'ReturnLongjs',
  DBUS_DEP0002: 'variant index chain',
  DBUS_DEP0003: 'dict read as an array of pairs'
};

function report(fileInfo, node, code, detail, hint, confidence) {
  process.stdout.write(
    `${MARKER}${JSON.stringify({
      file: fileInfo.path,
      line: node.loc ? node.loc.start.line : 0,
      column: node.loc ? node.loc.start.column + 1 : 0,
      code,
      rule: RULES[code],
      detail,
      hint,
      confidence
    })}\n`
  );
}

// Render an index chain back to something recognisable, e.g. `[1][1][0]`.
function indexChain(node) {
  const parts = [];
  let cur = node;
  while (
    cur &&
    cur.type === 'MemberExpression' &&
    cur.computed &&
    cur.property &&
    cur.property.type === 'Literal' &&
    typeof cur.property.value === 'number'
  ) {
    parts.unshift(`[${cur.property.value}]`);
    cur = cur.object;
  }
  return parts.join('');
}

const isIndex = (node, value) =>
  node &&
  node.type === 'MemberExpression' &&
  node.computed &&
  node.property &&
  node.property.type === 'Literal' &&
  node.property.value === value;

module.exports = function transform(fileInfo, api, options) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);
  const only = options && options.rule ? String(options.rule).split(',') : null;
  const wanted = code => !only || only.includes(code);

  // --- DBUS_DEP0002: `x[1][0]`, the variant unwrap -------------------------
  //
  // A variant unmarshals as [signatureTree, [value]], so the value is at
  // [1][0]. Any `[0]` applied directly to a `[1]` is that shape.
  if (wanted('DBUS_DEP0002')) {
    root.find(j.MemberExpression, { computed: true }).forEach(path => {
      const node = path.node;
      if (!isIndex(node, 0) || !isIndex(node.object, 1)) return;
      // Report the outermost chain only, so `a[1][1][0]` is one finding.
      if (isIndex(path.parent.node, 0) && path.parent.node.object === node)
        return;
      report(
        fileInfo,
        node,
        'DBUS_DEP0002',
        `variant index chain \`${indexChain(node)}\``,
        'variantValue(), or a plain property read after 0.14.0',
        'high'
      );
    });
  }

  // --- DBUS_DEP0003: iterating a dict as [key, value] pairs ----------------
  //
  // Lower confidence by nature: `for (const [k, v] of Object.entries(o))` is
  // the same syntax and is not affected. We exclude the standard producers of
  // pairs and say so in the report, because a linter that cries wolf gets
  // switched off.
  if (wanted('DBUS_DEP0003')) {
    const fromStandardPairSource = right => {
      if (!right) return false;
      if (right.type === 'CallExpression') {
        const callee = right.callee;
        if (
          callee &&
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          PAIR_SOURCES.has(callee.property.name)
        )
          return true;
      }
      return false;
    };

    root.find(j.ForOfStatement).forEach(path => {
      const left = path.node.left;
      const decl =
        left.type === 'VariableDeclaration' ? left.declarations[0].id : left;
      if (!decl || decl.type !== 'ArrayPattern') return;
      if (decl.elements.length !== 2) return;
      if (fromStandardPairSource(path.node.right)) return;
      report(
        fileInfo,
        path.node,
        'DBUS_DEP0003',
        'iterating `[key, value]` pairs',
        'toPlain(), or read it as an object after 0.14.0',
        'possible'
      );
    });

    // `dict.find(([key]) => key === 'Udi')` -- the other common pair idiom.
    root
      .find(j.CallExpression, {
        callee: { type: 'MemberExpression', property: { name: 'find' } }
      })
      .forEach(path => {
        const [fn] = path.node.arguments;
        if (
          !fn ||
          (fn.type !== 'ArrowFunctionExpression' &&
            fn.type !== 'FunctionExpression')
        )
          return;
        const [param] = fn.params;
        if (!param || param.type !== 'ArrayPattern') return;
        report(
          fileInfo,
          path.node,
          'DBUS_DEP0003',
          'searching `[key, value]` pairs',
          'toPlain(), then read the property directly',
          'possible'
        );
      });
  }

  // --- DBUS_DEP0001: the ReturnLongjs option -------------------------------
  if (wanted('DBUS_DEP0001')) {
    root.find(j.Identifier, { name: 'ReturnLongjs' }).forEach(path => {
      // Only where it is used as an option, not in a string or a comment.
      const parent = path.parent.node;
      const isKey = parent.type === 'Property' && parent.key === path.node;
      const isProp =
        parent.type === 'MemberExpression' && parent.property === path.node;
      if (!isKey && !isProp) return;
      report(
        fileInfo,
        path.node,
        'DBUS_DEP0001',
        '`ReturnLongjs` option',
        '64-bit values become native BigInt in 0.14.0; plan for the TypeError',
        'high'
      );
    });
  }

  // A linter never rewrites.
  return null;
};

module.exports.parser = 'babel';
module.exports.MARKER = MARKER;
module.exports.RULES = RULES;
