// Fixtures for the deprecated-value-shapes linter.
//
// The rules that matter most here are the negative ones. A linter that flags
// `for (const [k, v] of Object.entries(o))` -- ordinary JavaScript that 0.14.0
// does not touch -- gets switched off, and then it protects nobody.

const { describe, it } = require('node:test');
const assert = require('assert');
const jscodeshift = require('jscodeshift');
const lint = require('../lib/lint/deprecated-value-shapes');

// The transform reports on stdout so its findings survive jscodeshift's worker
// processes; capture them rather than letting them into the test output.
function run(source, options = {}) {
  const findings = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => {
    const line = String(chunk);
    if (line.startsWith(lint.MARKER)) {
      findings.push(JSON.parse(line.slice(lint.MARKER.length)));
      return true;
    }
    return original.call(process.stdout, chunk);
  };
  let result;
  try {
    const j = jscodeshift.withParser('babel');
    result = lint(
      { path: 'input.js', source },
      { jscodeshift: j, j, stats: () => {} },
      options
    );
  } finally {
    process.stdout.write = original;
  }
  return { findings, result };
}

const codes = findings => findings.map(f => f.code).sort();

describe('lint: DBUS_DEP0002, variant index chains', () => {
  it('flags the variant unwrap', () => {
    const { findings } = run('const v = entry[1][0];', {
      rule: 'DBUS_DEP0002'
    });
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].code, 'DBUS_DEP0002');
    assert.match(findings[0].detail, /\[1\]\[0\]/);
    assert.strictEqual(findings[0].confidence, 'high');
  });

  it('reports a longer chain once, with the whole chain', () => {
    // `dict.find(...)[1][1][0]` is one mistake, not two.
    const { findings } = run(
      "const udi = dict.find(([k]) => k === 'Udi')[1][1][0];",
      { rule: 'DBUS_DEP0002' }
    );
    assert.strictEqual(findings.length, 1);
    assert.match(findings[0].detail, /\[1\]\[1\]\[0\]/);
  });

  it('reports the line it is on', () => {
    const { findings } = run('\n\nconst v = entry[1][0];', {
      rule: 'DBUS_DEP0002'
    });
    assert.strictEqual(findings[0].line, 3);
  });

  it('leaves an unrelated index alone', () => {
    // `[0][1]` is not the variant shape, and neither is a plain `[0]`.
    const { findings } = run(
      'const a = xs[0]; const b = xs[0][1]; const c = xs[2][0];',
      { rule: 'DBUS_DEP0002' }
    );
    assert.deepStrictEqual(findings, []);
  });

  it('leaves a non-numeric index alone', () => {
    const { findings } = run('const v = entry[k][0];', {
      rule: 'DBUS_DEP0002'
    });
    assert.deepStrictEqual(findings, []);
  });
});

describe('lint: DBUS_DEP0003, dicts read as pairs', () => {
  it('flags iterating pairs', () => {
    const { findings } = run('for (const [k, v] of props) use(k, v);', {
      rule: 'DBUS_DEP0003'
    });
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].confidence, 'possible');
  });

  it('flags searching pairs', () => {
    const { findings } = run("dict.find(([key]) => key === 'Udi');", {
      rule: 'DBUS_DEP0003'
    });
    assert.strictEqual(findings.length, 1);
    assert.match(findings[0].detail, /searching/);
  });

  // The whole point of the exclusion list.
  it('does not flag Object.entries', () => {
    const { findings } = run(
      'for (const [k, v] of Object.entries(obj)) use(k, v);',
      { rule: 'DBUS_DEP0003' }
    );
    assert.deepStrictEqual(findings, []);
  });

  it('does not flag a Map or an iterator helper', () => {
    for (const src of [
      'for (const [k, v] of map.entries()) use(k, v);',
      'for (const [k, v] of thing.values()) use(k, v);'
    ]) {
      const { findings } = run(src, { rule: 'DBUS_DEP0003' });
      assert.deepStrictEqual(findings, [], src);
    }
  });

  it('does not flag destructuring of a different arity', () => {
    const { findings } = run('for (const [a, b, c] of rows) use(a, b, c);', {
      rule: 'DBUS_DEP0003'
    });
    assert.deepStrictEqual(findings, []);
  });

  it('does not flag find() with an ordinary parameter', () => {
    const { findings } = run('xs.find(x => x.id === 3);', {
      rule: 'DBUS_DEP0003'
    });
    assert.deepStrictEqual(findings, []);
  });
});

describe('lint: DBUS_DEP0001, ReturnLongjs', () => {
  it('flags the option', () => {
    const { findings } = run(
      'const bus = dbus.sessionBus({ ReturnLongjs: true });'
    );
    assert.ok(findings.some(f => f.code === 'DBUS_DEP0001'));
  });

  it('does not flag the name in a string', () => {
    const { findings } = run("const s = 'ReturnLongjs';", {
      rule: 'DBUS_DEP0001'
    });
    assert.deepStrictEqual(findings, []);
  });
});

describe('lint: behaviour', () => {
  it('never modifies the source', () => {
    // It is a linter. Returning anything but null would make jscodeshift
    // rewrite the file.
    const { result } = run('const v = entry[1][0];');
    assert.strictEqual(result, null);
  });

  it('reports the forward-compatible helper as the fix', () => {
    const { findings } = run('const v = entry[1][0];');
    assert.match(findings[0].hint, /variantValue/);
  });

  it('says nothing about code already using the helpers', () => {
    const { findings } = run(
      `const { variantValue, toPlain } = require('dbus-native');
       const udi = variantValue(entry);
       const props = toPlain(dict);`
    );
    assert.deepStrictEqual(findings, []);
  });

  it('runs every rule when none is selected', () => {
    const { findings } = run(
      `const bus = dbus.sessionBus({ ReturnLongjs: true });
       const v = entry[1][0];
       for (const [k, x] of props) use(k, x);`
    );
    assert.deepStrictEqual(codes(findings), [
      'DBUS_DEP0001',
      'DBUS_DEP0002',
      'DBUS_DEP0003'
    ]);
  });

  it('honours a comma-separated rule filter', () => {
    const src = `const bus = dbus.sessionBus({ ReturnLongjs: true });
       const v = entry[1][0];
       for (const [k, x] of props) use(k, x);`;
    const { findings } = run(src, { rule: 'DBUS_DEP0001,DBUS_DEP0002' });
    assert.deepStrictEqual(codes(findings), ['DBUS_DEP0001', 'DBUS_DEP0002']);
  });
});
