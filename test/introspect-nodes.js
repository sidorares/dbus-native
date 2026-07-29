// What the Introspect reply says about child objects.
//
// The reply for a path describes one object: the interfaces exported there,
// and a <node name="..."/> per immediate child. A path that is itself exported
// used to advertise no children at all, so a tree built with this library
// could not be walked -- see #140.

const { describe, it } = require('node:test');
const assert = require('assert');
const stdifaces = require('../lib/stdifaces');

const iface = name => ({
  name,
  methods: { Ping: ['', ''] },
  signals: {},
  properties: {}
});

// Build a bus exporting an interface at each of `paths`, and introspect `at`.
function introspect(paths, at) {
  const exportedObjects = {};
  for (const path of paths) {
    exportedObjects[path] = {
      [`com.example${path.replace(/\//g, '.')}`]: [
        iface(`com.example${path.replace(/\//g, '.')}`),
        {}
      ]
    };
  }
  let reply;
  stdifaces(
    {
      interface: 'org.freedesktop.DBus.Introspectable',
      member: 'Introspect',
      path: at,
      serial: 1,
      sender: ':1.2'
    },
    {
      serial: 1,
      exportedObjects,
      connection: {
        message: msg => {
          reply = msg;
        }
      }
    }
  );
  const xml = reply.body[0];
  return {
    xml,
    nodes: [...xml.matchAll(/<node name="([^"]+)"/g)].map(m => m[1]),
    ifaces: [...xml.matchAll(/<interface name="(com\.[^"]+)"/g)].map(m => m[1])
  };
}

const TREE = [
  '/com/example/Tree',
  '/com/example/Tree/Alpha',
  '/com/example/Tree/Beta',
  '/com/example/Tree/Beta/Deep',
  '/com/example/Treeish',
  '/com/example/Bare/Child'
];

describe('Introspect: child nodes', () => {
  it('lists the children of a path that is itself exported', () => {
    const { nodes, ifaces } = introspect(TREE, '/com/example/Tree');
    assert.deepStrictEqual(nodes, ['Alpha', 'Beta']);
    assert.deepStrictEqual(
      ifaces,
      ['com.example.com.example.Tree'],
      'and its own interface'
    );
  });

  it('lists a grandchild by its parent, once', () => {
    // /com/example/Tree/Beta/Deep contributes 'Beta', which is already there.
    const { nodes } = introspect(TREE, '/com/example/Tree');
    assert.strictEqual(nodes.filter(n => n === 'Beta').length, 1);

    const beta = introspect(TREE, '/com/example/Tree/Beta');
    assert.deepStrictEqual(beta.nodes, ['Deep']);
  });

  it('lists the children of a path that exports nothing', () => {
    const { nodes, ifaces } = introspect(TREE, '/com/example/Bare');
    assert.deepStrictEqual(nodes, ['Child']);
    assert.deepStrictEqual(ifaces, []);
  });

  it('does not treat a path with a common prefix as a child', () => {
    // '/com/example/Treeish' is not below '/com/example/Tree'.
    const { nodes } = introspect(TREE, '/com/example/Tree');
    assert.ok(!nodes.includes('Treeish'));
    assert.ok(!nodes.includes('ish'));
  });

  it('reports nothing for a path that is neither exported nor a parent', () => {
    const { xml } = introspect(TREE, '/com/example/Tre');
    assert.match(xml, /<node\/>/);
  });

  it('lists every branch below an intermediate path', () => {
    const { nodes } = introspect(TREE, '/com/example');
    assert.deepStrictEqual(nodes.sort(), ['Bare', 'Tree', 'Treeish']);
  });

  it('descends from the root', () => {
    const { nodes } = introspect(TREE, '/');
    assert.deepStrictEqual(nodes, ['com']);
  });

  it('serves an object with no children as it always did', () => {
    const { nodes, ifaces } = introspect(TREE, '/com/example/Tree/Alpha');
    assert.deepStrictEqual(nodes, []);
    assert.deepStrictEqual(ifaces, ['com.example.com.example.Tree.Alpha']);
    // The standard interfaces still come with it.
    const { xml } = introspect(TREE, '/com/example/Tree/Alpha');
    assert.match(xml, /org\.freedesktop\.DBus\.Properties/);
    assert.match(xml, /org\.freedesktop\.DBus\.Introspectable/);
    assert.match(xml, /org\.freedesktop\.DBus\.Peer/);
  });

  it('does not offer the standard interfaces on a bare container', () => {
    // Nothing is exported there, so there is nothing to answer Properties.Get.
    const { xml } = introspect(TREE, '/com/example/Bare');
    assert.doesNotMatch(xml, /org\.freedesktop\.DBus\.Properties/);
  });
});
