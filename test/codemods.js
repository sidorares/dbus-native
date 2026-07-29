// Fixtures for the errors-to-error-objects codemod.
//
// The interesting cases are not the rewrites -- those are mechanical -- but
// the refusals: an `err[0]` the transform cannot attribute to a d-bus call
// must be left exactly as it was.

const { describe, it } = require('node:test');
const assert = require('assert');
const jscodeshift = require('jscodeshift');
const transform = require('../lib/codemods/errors-to-error-objects');

// Returns the rewritten source, or null when the transform declined to touch
// the file -- the same contract jscodeshift itself uses.
function run(source) {
  const j = jscodeshift.withParser('babel');
  return transform(
    { path: 'input.js', source },
    { jscodeshift: j, j, stats: () => {} },
    { quiet: true }
  );
}

// Compare ignoring leading/trailing whitespace only; everything else must
// match, because a codemod that reformats unrelated lines is unreviewable.
function expectRewrite(input, expected) {
  const out = run(input);
  assert.notStrictEqual(out, null, 'expected the transform to make a change');
  assert.strictEqual(out.trim(), expected.trim());
}

function expectUntouched(input) {
  assert.strictEqual(run(input), null, 'expected no change');
}

describe('codemod: errors-to-error-objects', () => {
  it('rewrites err[0] to err.message', () => {
    expectRewrite(
      `bus.invoke(msg, (err, result) => {
  if (err) console.error(err[0]);
});`,
      `bus.invoke(msg, (err, result) => {
  if (err) console.error(err.message);
});`
    );
  });

  it('unwraps new Error(err[0])', () => {
    expectRewrite(
      `bus.invoke(msg, (err, result) => {
  if (err) return reject(new Error(err[0]));
});`,
      `bus.invoke(msg, (err, result) => {
  if (err) return reject(err);
});`
    );
  });

  it('sends higher indices to err.body', () => {
    // Only body[0] became `message`; an error that really does carry several
    // arguments keeps them.
    expectRewrite(
      `bus.invoke(msg, err => {
  log(err[0], err[1], err[2]);
});`,
      `bus.invoke(msg, err => {
  log(err.message, err.body[1], err.body[2]);
});`
    );
  });

  it('redirects array destructuring to err.body', () => {
    expectRewrite(
      `bus.invoke(msg, err => {
  const [text, code] = err;
});`,
      `bus.invoke(msg, err => {
  const [text, code] = err.body;
});`
    );
  });

  it('works on the bus meta methods and the proxy accessors', () => {
    for (const method of [
      'invokeDbus',
      'getInterface',
      'getObject',
      'addMatch',
      'listNames',
      'requestName',
      'nameHasOwner',
      '$readProp'
    ]) {
      expectRewrite(
        `bus.${method}(a, err => log(err[0]));`,
        `bus.${method}(a, err => log(err.message));`
      );
    }
  });

  it('uses whatever the callback called its first parameter', () => {
    expectRewrite(
      `bus.invoke(msg, function (e, result) {
  if (e) throw new Error(e[0]);
});`,
      `bus.invoke(msg, function (e, result) {
  if (e) throw e;
});`
    );
  });

  it('leaves a call site it cannot attribute alone', () => {
    // A proxy method call: the member name is the *remote* method, so it could
    // be anything and there is nothing to match on.
    expectUntouched(`iface.Echo('hi', (err, result) => {
  if (err) return reject(new Error(err[0]));
});`);
  });

  it('leaves an unrelated err[0] alone', () => {
    expectUntouched(`fs.readFile(f, (err, data) => {
  if (err) console.error(err[0]);
});`);
  });

  it('does not rewrite a shadowing binding of the same name', () => {
    // The inner `err` is a different variable that happens to share the name.
    // Rewriting it would change unrelated code.
    expectRewrite(
      `bus.invoke(msg, (err, result) => {
  helper(function (err) {
    return err[0];
  });

  return err[0];
});`,
      `bus.invoke(msg, (err, result) => {
  helper(function (err) {
    return err[0];
  });

  return err.message;
});`
    );
  });

  it('leaves a file with nothing to do untouched', () => {
    expectUntouched(`bus.invoke(msg, (err, result) => {
  if (err) return reject(err);
  console.log(result);
});`);
  });

  it('does not touch a non-numeric index', () => {
    // `err[key]` could be anything; only integer indices were the body.
    expectUntouched(`bus.invoke(msg, err => {
  return err[key];
});`);
  });

  it('reports suspicious sites it declined to rewrite', () => {
    const warnings = [];
    const original = console.warn;
    console.warn = m => warnings.push(m);
    try {
      const j = jscodeshift.withParser('babel');
      transform(
        {
          path: 'input.js',
          source: `iface.Echo('hi', (err, r) => log(err[0]));`
        },
        { jscodeshift: j, j, stats: () => {} },
        {}
      );
    } finally {
      console.warn = original;
    }
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /DBUS_DEP0004/);
    assert.match(warnings[0], /err\[0\]/);
    assert.match(warnings[0], /review by hand/);
  });
});
