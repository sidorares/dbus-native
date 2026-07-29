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

const ts = (signature, target = 'classic') =>
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

  it('maps 64-bit per target, since 2.0 makes them bigint', () => {
    assert.strictEqual(ts('x'), 'number');
    assert.strictEqual(ts('t'), 'number');
    assert.strictEqual(ts('x', 'next'), 'bigint');
    assert.strictEqual(ts('t', 'next'), 'bigint');
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

  // The shape people complain about, and the shape it becomes.
  it('maps dicts per target', () => {
    assert.strictEqual(ts('a{ss}'), 'Array<[string, string]>');
    assert.strictEqual(ts('a{sv}'), 'Array<[string, ClassicVariant]>');
    assert.strictEqual(ts('a{ss}', 'next'), 'Record<string, string>');
    assert.strictEqual(ts('a{sv}', 'next'), 'Record<string, unknown>');
  });

  it('maps variants per target', () => {
    assert.strictEqual(ts('v'), 'ClassicVariant');
    assert.strictEqual(ts('v', 'next'), 'unknown');
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
    assert.match(output, /target: {2}classic/);
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
      /on\(event: 'StateChanged', listener: \(state: number, error: string\) => void\): void;/
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
