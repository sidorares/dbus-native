const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseIntrospection } = require('../lib/codegen/introspection');
const { emitTypes, typeName } = require('../lib/codegen/emit-types');
const { signatureToTs, returnToTs } = require('../lib/codegen/types');

const fixture = fs.readFileSync(
  path.join(__dirname, 'fixtures/introspection/example.xml'),
  'utf8'
);

const ts = (signature, target = 'plain') =>
  signatureToTs(signature, { target })[0];

describe('codegen: signature -> TypeScript', () => {
  it('maps the scalar types', () => {
    assert.strictEqual(ts('s'), 'string');
    assert.strictEqual(ts('o'), 'string');
    assert.strictEqual(ts('g'), 'string');
    assert.strictEqual(ts('b'), 'boolean');
    for (const t of ['y', 'n', 'q', 'i', 'u', 'd']) {
      assert.strictEqual(ts(t), 'number', t);
    }
  });

  it('maps 64-bit per target, since only the classic shape is a number', () => {
    assert.strictEqual(ts('x'), 'bigint');
    assert.strictEqual(ts('t'), 'bigint');
    assert.strictEqual(ts('x', 'classic'), 'number');
    assert.strictEqual(ts('t', 'classic'), 'number');
  });

  it('maps arrays, and ay to Buffer', () => {
    assert.strictEqual(ts('as'), 'string[]');
    assert.strictEqual(ts('ai'), 'number[]');
    assert.strictEqual(ts('aas'), 'string[][]');
    assert.strictEqual(ts('ay'), 'Buffer');
    assert.strictEqual(ts('aay'), 'Buffer[]');
  });

  it('maps structs to tuples', () => {
    assert.strictEqual(ts('(is)'), '[number, string]');
    assert.strictEqual(ts('a(is)'), '[number, string][]');
    assert.strictEqual(ts('((i)(s))'), '[[number], [string]]');
  });

  // The shape people complained about, and the shape it became.
  it('maps dicts per target', () => {
    assert.strictEqual(ts('a{ss}'), 'Record<string, string>');
    assert.strictEqual(ts('a{sv}'), 'Record<string, unknown>');
    assert.strictEqual(ts('a{ss}', 'classic'), 'Array<[string, string]>');
    assert.strictEqual(
      ts('a{sv}', 'classic'),
      'Array<[string, ClassicVariant]>'
    );
  });

  it('maps variants per target', () => {
    assert.strictEqual(ts('v'), 'unknown');
    assert.strictEqual(ts('v', 'classic'), 'ClassicVariant');
  });

  it('maps a reply to void, a value, or a tuple', () => {
    assert.strictEqual(returnToTs('', {}), 'void');
    assert.strictEqual(returnToTs('s', {}), 'string');
    assert.strictEqual(returnToTs('si', {}), '[string, number]');
  });
});

describe('codegen: introspection parsing', () => {
  it('reads interfaces, methods, signals and properties', async () => {
    const d = await parseIntrospection(fixture);
    const iface = d.interfaces.find(i =>
      i.name.endsWith('InterestingInterface')
    );
    assert.ok(iface, 'expected the example interface');

    const add = iface.methods.find(m => m.name === 'AddContact');
    assert.deepStrictEqual(
      add.args.map(a => [a.name, a.type]),
      [
        ['name', 's'],
        ['email', 's']
      ]
    );
    assert.deepStrictEqual(
      add.returns.map(a => [a.name, a.type]),
      [['id', 'u']]
    );

    assert.ok(iface.signals.some(s => s.name === 'StateChanged'));
  });

  // #148: dbus2js crashed on a node with no interfaces
  it('does not throw when a node exposes no interfaces', async () => {
    const d = await parseIntrospection('<node><node name="child"/></node>');
    assert.deepStrictEqual(d.interfaces, []);
    assert.deepStrictEqual(d.nodes, ['child']);
  });

  it('rejects data with no root node', async () => {
    await assert.rejects(() => parseIntrospection('<nope/>'), /root <node>/);
  });
});

describe('codegen: emitted declarations', () => {
  let output;
  before(async () => {
    output = emitTypes(await parseIntrospection(fixture), {
      service: 'com.example.MyService1',
      path: '/com/example'
    });
  });

  it('names interfaces after their d-bus name', () => {
    assert.strictEqual(
      typeName('org.freedesktop.NetworkManager.Device'),
      'OrgFreedesktopNetworkManagerDevice'
    );
    assert.match(output, /export interface ComExampleMyService1\w+/);
  });

  it('records the service, path and target in the header', () => {
    assert.match(output, /service: com\.example\.MyService1/);
    assert.match(output, /path: {4}\/com\/example/);
    assert.match(output, /target: {2}plain/);
  });

  it('emits methods with named parameters and a DBusPromise return', () => {
    assert.match(
      output,
      /AddContact\(name: string, email: string\): DBusPromise<number>;/
    );
  });

  it('emits signals as typed on() overloads', () => {
    assert.match(
      output,
      /on\(event: 'StateChanged', listener: \(state: number, error: string\) => void\): this;/
    );
  });

  it('emits a matching once() overload for each signal', () => {
    assert.match(
      output,
      /once\(event: 'StateChanged', listener: \(state: number, error: string\) => void\): this;/
    );
  });

  it('extends DBusInterface so the library members are present', () => {
    assert.match(output, /extends DBusInterface/);
  });

  it('imports only the types it uses', () => {
    const noVariants = emitTypes(
      {
        interfaces: [{ name: 'a.B', methods: [], signals: [], properties: [] }],
        nodes: []
      },
      {}
    );
    assert.doesNotMatch(noVariants, /ClassicVariant/);
  });

  it('skips the standard interfaces unless asked', async () => {
    const d = await parseIntrospection(
      `<node>
         <interface name="org.freedesktop.DBus.Peer">
           <method name="Ping"/>
         </interface>
         <interface name="com.example.Real">
           <method name="Go"/>
         </interface>
       </node>`
    );
    const skipped = emitTypes(d, { skipStandard: true });
    assert.doesNotMatch(skipped, /Peer/);
    assert.match(skipped, /ComExampleReal/);

    const all = emitTypes(d, { skipStandard: false });
    assert.match(all, /OrgFreedesktopDBusPeer/);
  });

  it('names unnamed parameters and escapes reserved words', async () => {
    const d = await parseIntrospection(
      `<node><interface name="a.B"><method name="M">
         <arg direction="in" type="s"/>
         <arg direction="in" type="i" name="class"/>
         <arg direction="in" type="s" name="has-dash"/>
       </method></interface></node>`
    );
    // `class` is reserved, so it cannot be used as a parameter name, and a
    // dash is not a valid identifier character.
    assert.match(
      emitTypes(d, {}),
      /M\(in0: string, class_: number, has_dash: string\)/
    );
  });

  it('marks deprecated methods', async () => {
    const d = await parseIntrospection(
      `<node><interface name="a.B"><method name="Old">
         <annotation name="org.freedesktop.DBus.Deprecated" value="true"/>
       </method></interface></node>`
    );
    assert.match(emitTypes(d, {}), /@deprecated/);
  });

  it('emits an empty but valid module when there are no interfaces', () => {
    const out = emitTypes({ interfaces: [], nodes: [] }, {});
    assert.match(out, /^\/\/ Generated by/);
    assert.doesNotMatch(out, /export interface \w+ extends/);
  });
});

// The target names are the two the CLI accepts, and one of them is a rename:
// what is now 'plain' was called 'next' while these shapes were the future,
// and is still written down in whatever script generated the file being
// regenerated.
describe('codegen: the --target flag', () => {
  const { execFileSync } = require('child_process');
  const os = require('os');
  const bin = path.join(__dirname, '..', 'bin', 'dbus-native.js');

  // The two signatures whose TypeScript depends on the target, which the
  // example fixture happens not to contain.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-target-'));
  const xml = path.join(dir, 'shapes.xml');
  fs.writeFileSync(
    xml,
    `<node><interface name="com.example.Shapes"><method name="M">
       <arg direction="out" type="a{sv}" name="props"/>
       <arg direction="out" type="t" name="size"/>
     </method></interface></node>`
  );
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const generate = (...args) =>
    execFileSync(process.execPath, [bin, 'types', '--xml', xml, ...args], {
      encoding: 'utf8'
    });

  it("defaults to 'plain', which is what the library returns", () => {
    const out = generate();
    assert.match(out, /target: {2}plain/);
    assert.match(out, /\[Record<string, unknown>, bigint\]/);
  });

  it("still accepts 'next', the name 'plain' used to have", () => {
    assert.strictEqual(generate('--target', 'next'), generate());
  });

  it("emits the 1.x shapes for 'classic'", () => {
    const out = generate('--target', 'classic');
    assert.match(out, /target: {2}classic/);
    assert.match(out, /\[Array<\[string, ClassicVariant\]>, number\]/);
  });

  it('names the targets it accepts when given another', () => {
    assert.throws(
      () => generate('--target', 'bogus'),
      /--target must be 'plain' or 'classic', got 'bogus'/
    );
  });
});
