// Which object does an introspected proxy actually point at, and which
// children does it report?
//
// Both used to be wrong in the same function. A path with no interfaces was
// silently replaced by its first child, and the child list dropped whichever
// child came first.

const { describe, it } = require('node:test');
const assert = require('assert');
const introspect = require('../lib/introspect');
const { UnknownInterfaceError } = require('../lib/errors');

const PATH = '/com/example/Obj';

const parse = (xml, obj) =>
  new Promise((resolve, reject) =>
    introspect.processXML(
      null,
      xml,
      obj || { name: PATH, service: { name: 'com.example', bus: {} } },
      (err, proxy, nodes) => (err ? reject(err) : resolve({ proxy, nodes }))
    )
  );

const withIface = `
  <node>
    <interface name="com.example.Iface"><method name="Ping"/></interface>
    <node name="Alpha"/>
    <node name="Beta"/>
    <node name="Gamma"/>
  </node>`;

describe('introspection: the child node list', () => {
  it('includes the first child, which used to be dropped', async () => {
    const { nodes } = await parse(withIface);
    assert.deepStrictEqual(nodes, ['Alpha', 'Beta', 'Gamma']);
  });

  it('reports a lone child rather than nothing at all', async () => {
    // The same answer lib/codegen.js has always given for this document.
    const { nodes } = await parse(
      '<node><interface name="com.example.I"/><node name="child"/></node>'
    );
    assert.deepStrictEqual(nodes, ['child']);
  });

  it('is empty for an object with no children', async () => {
    const { nodes } = await parse(
      '<node><interface name="com.example.I"/></node>'
    );
    assert.deepStrictEqual(nodes, []);
  });

  it('ignores a <node> with no name attribute', async () => {
    const { nodes } = await parse(
      '<node><interface name="com.example.I"/><node/><node name="real"/></node>'
    );
    assert.deepStrictEqual(nodes, ['real']);
  });
});

describe('introspection: a path with no interfaces', () => {
  const container = '<node><node name="Alpha"/><node name="Beta"/></node>';

  it('describes the object asked for, not its first child', async () => {
    const { proxy, nodes } = await parse(container);
    assert.deepStrictEqual(Object.keys(proxy), []);
    assert.deepStrictEqual(nodes, ['Alpha', 'Beta'], 'every child, in order');
  });

  it('leaves the caller object alone', async () => {
    // `Object.assign(obj, {})` assigns nothing onto obj and returns obj, so
    // the redirect rewrote the caller's own object path in place.
    const obj = { name: PATH, service: { name: 'com.example', bus: {} } };
    await parse(container, obj);
    assert.strictEqual(obj.name, PATH);
  });

  it('succeeds even with no children at all', async () => {
    const { proxy, nodes } = await parse('<node/>');
    assert.deepStrictEqual(Object.keys(proxy), []);
    assert.deepStrictEqual(nodes, []);
  });

  it('still builds a proxy when interfaces are present', async () => {
    const { proxy } = await parse(withIface);
    assert.ok(proxy['com.example.Iface']);
    assert.strictEqual(typeof proxy['com.example.Iface'].Ping, 'function');
  });
});

describe('introspection: a reply that is not a node document', () => {
  it('reaches the callback instead of throwing past it', async () => {
    // This used to `throw` from inside the xml2js callback, which runs under
    // the socket read handler -- so it surfaced as an uncaught exception
    // rather than as an error for the caller.
    await assert.rejects(() => parse('<nope/>'), /No root XML node/);
  });

  it('reports malformed XML as an error too', async () => {
    await assert.rejects(() => parse('<node><unclosed></node>'));
  });
});

describe('UnknownInterfaceError names the children', () => {
  it('points at the child objects when there are no interfaces', () => {
    const err = new UnknownInterfaceError(
      'com.example.Alpha',
      PATH,
      'com.example',
      [],
      ['Alpha', 'Beta']
    );
    assert.match(err.message, /no interfaces of its own/);
    assert.match(err.message, /child objects: Alpha, Beta/);
  });

  it('prefers listing the interfaces that are there', () => {
    const err = new UnknownInterfaceError(
      'com.example.Nope',
      PATH,
      'com.example',
      ['com.example.Real'],
      ['Alpha']
    );
    assert.match(err.message, /Available: com\.example\.Real\./);
    assert.doesNotMatch(err.message, /child objects/);
  });

  it('says neither when there is nothing to say', () => {
    const err = new UnknownInterfaceError('a.b', PATH, 'com.example', [], []);
    assert.match(err.message, /No such interface "a\.b"/);
    assert.doesNotMatch(err.message, /child objects|Available/);
  });
});
