// The path arithmetic and body shapes behind org.freedesktop.DBus.ObjectManager.
//
// Kept separate from the end-to-end test because these are the parts with edge
// cases -- '/' is not like any other path, and "below" has to exclude the
// manager itself and near-misses like /a/bc under /a/b.

const { describe, it } = require('node:test');
const assert = require('assert');
const om = require('../lib/object-manager');

// Two objects' worth of exportedObjects, in the shape bus.js keeps.
const exported = (properties, impl) => ({
  'com.example.Thing': [{ name: 'com.example.Thing', properties }, impl]
});

describe('object manager: isBelow', () => {
  it('excludes the manager itself', () => {
    assert.strictEqual(om.isBelow('/a/b', '/a/b'), false);
    assert.strictEqual(om.isBelow('/', '/'), false);
  });

  it('includes descendants at any depth', () => {
    assert.strictEqual(om.isBelow('/a/b', '/a/b/c'), true);
    assert.strictEqual(om.isBelow('/a/b', '/a/b/c/d'), true);
  });

  it("treats '/' as the parent of everything", () => {
    // The case that breaks naive prefix arithmetic: `'/' + '/'` would ask
    // whether the path starts with '//'.
    assert.strictEqual(om.isBelow('/', '/a'), true);
    assert.strictEqual(om.isBelow('/', '/org/bluez/hci0'), true);
  });

  it('does not mistake a sibling with a shared prefix for a child', () => {
    assert.strictEqual(om.isBelow('/a/b', '/a/bc'), false);
    assert.strictEqual(om.isBelow('/a/b', '/a/bc/d'), false);
  });

  it('excludes ancestors and unrelated paths', () => {
    assert.strictEqual(om.isBelow('/a/b', '/a'), false);
    assert.strictEqual(om.isBelow('/a/b', '/x/y'), false);
  });
});

describe('object manager: managerFor', () => {
  it('is undefined when nothing manages the path', () => {
    assert.strictEqual(om.managerFor(new Set(['/a']), '/b/c'), undefined);
    assert.strictEqual(om.managerFor(new Set(), '/b/c'), undefined);
  });

  it('picks the deepest manager, so an object is announced once', () => {
    const managers = new Set(['/', '/a', '/a/b']);
    assert.strictEqual(om.managerFor(managers, '/a/b/c'), '/a/b');
    assert.strictEqual(om.managerFor(managers, '/a/x'), '/a');
    assert.strictEqual(om.managerFor(managers, '/z'), '/');
  });

  it('does not let a manager announce itself', () => {
    assert.strictEqual(om.managerFor(new Set(['/a']), '/a'), undefined);
  });
});

describe('object manager: bodies', () => {
  const impl = { Name: 'eth0', Secret: 'shh', Mtu: 1500 };
  const props = {
    Name: 's',
    Mtu: { type: 'u', access: 'read' },
    Secret: { type: 's', access: 'write' }
  };

  it('omits write-only properties, as GetAll does', () => {
    assert.deepStrictEqual(om.readableProperties({ properties: props }, impl), [
      ['Name', ['s', 'eth0']],
      ['Mtu', ['u', 1500]]
    ]);
  });

  it('reports every interface at a path', () => {
    const obj = {
      'com.example.A': [{ properties: { X: 's' } }, { X: '1' }],
      'com.example.B': [{ properties: {} }, {}]
    };
    assert.deepStrictEqual(om.interfacesAndProperties(obj), [
      ['com.example.A', [['X', ['s', '1']]]],
      ['com.example.B', []]
    ]);
  });

  it('can be narrowed to the interfaces that just appeared', () => {
    const obj = {
      'com.example.A': [{ properties: { X: 's' } }, { X: '1' }],
      'com.example.B': [{ properties: {} }, {}]
    };
    assert.deepStrictEqual(om.interfacesAndProperties(obj, ['com.example.B']), [
      ['com.example.B', []]
    ]);
  });

  it('collects everything strictly below the manager', () => {
    const objects = {
      '/': exported({}, {}),
      '/a': exported({ P: 's' }, { P: 'one' }),
      '/a/b': exported({ P: 's' }, { P: 'two' })
    };
    assert.deepStrictEqual(om.managedObjects(objects, '/a'), [
      ['/a/b', [['com.example.Thing', [['P', ['s', 'two']]]]]]
    ]);
    assert.deepStrictEqual(
      om.managedObjects(objects, '/').map(([path]) => path),
      ['/a', '/a/b']
    );
  });

  it('surfaces a malformed declaration rather than emitting a bad body', () => {
    assert.throws(
      () =>
        om.readableProperties({ properties: { X: { access: 'read' } } }, {}),
      /must be declared as a signature string/
    );
  });
});

describe('object manager: signals', () => {
  it('InterfacesAdded is oa{sa{sv}} from the manager path', () => {
    const sig = om.addedSignal(7, '/', '/a', [['com.example.A', []]]);
    assert.strictEqual(sig.path, '/');
    assert.strictEqual(sig.member, 'InterfacesAdded');
    assert.strictEqual(sig.signature, 'oa{sa{sv}}');
    assert.deepStrictEqual(sig.body, ['/a', [['com.example.A', []]]]);
  });

  it('InterfacesRemoved is oas', () => {
    const sig = om.removedSignal(8, '/', '/a', ['com.example.A']);
    assert.strictEqual(sig.signature, 'oas');
    assert.deepStrictEqual(sig.body, ['/a', ['com.example.A']]);
  });
});
