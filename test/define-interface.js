// defineInterface(): what it compiles to, and what it refuses.
//
// It produces the classic positional descriptor, so everything it does can be
// checked without a bus -- the descriptor is the contract with the rest of the
// library. What needs a daemon is only that a service built this way answers,
// which is the integration test.

const { describe, it } = require('node:test');
const assert = require('assert');
const { defineInterface } = require('../lib/define-interface');

const MESSAGE = {
  sender: ':1.7',
  path: '/com/example/Obj',
  interface: 'com.example.I',
  member: 'Hello'
};

describe('defineInterface: the descriptor it compiles to', () => {
  it('turns named arguments into a signature and a name list', () => {
    const iface = defineInterface({
      name: 'com.example.I',
      methods: {
        Hello: {
          in: { name: 's', times: 'u' },
          out: { greeting: 's' },
          handler: () => ''
        }
      }
    });
    // Exactly what exportInterface has always taken.
    assert.deepStrictEqual(iface.descriptor.methods.Hello, [
      'su',
      's',
      ['name', 'times'],
      ['greeting']
    ]);
  });

  it('handles a method with no arguments either way', () => {
    const iface = defineInterface({
      name: 'com.example.I',
      methods: { Ping: { handler: () => {} } }
    });
    assert.deepStrictEqual(iface.descriptor.methods.Ping, ['', '', [], []]);
  });

  it('accepts a bare function as a method', () => {
    const iface = defineInterface({
      name: 'com.example.I',
      methods: { Ping: () => {} }
    });
    assert.deepStrictEqual(iface.descriptor.methods.Ping, ['', '', [], []]);
  });

  it('compiles signals to signature-then-names', () => {
    const iface = defineInterface({
      name: 'com.example.I',
      signals: { Greeted: { args: { who: 's', count: 'i' } } }
    });
    assert.deepStrictEqual(iface.descriptor.signals.Greeted, [
      'si',
      'who',
      'count'
    ]);
  });

  it('compiles properties to { type, access }', () => {
    const iface = defineInterface({
      name: 'com.example.I',
      properties: {
        A: 's',
        B: { type: 'd', access: 'read', get: () => 1 },
        C: { type: 'b', access: 'write', set: () => {} }
      }
    });
    assert.deepStrictEqual(iface.descriptor.properties, {
      A: { type: 's', access: 'readwrite' },
      B: { type: 'd', access: 'read' },
      C: { type: 'b', access: 'write' }
    });
  });

  it("accepts a property name with '-', as the looser rule allows", () => {
    const iface = defineInterface({
      name: 'com.example.I',
      properties: { 'my-prop': 's' }
    });
    assert.ok(iface.descriptor.properties['my-prop']);
  });
});

describe('defineInterface: handlers', () => {
  const call = (iface, member, ...body) =>
    iface.impl[member].apply(iface.impl, [...body, MESSAGE]);

  it('receives arguments by name', () => {
    const iface = defineInterface({
      name: 'com.example.I',
      methods: {
        Hello: {
          in: { name: 's', times: 'u' },
          out: { greeting: 's' },
          handler: ({ name, times }) => `${name} x${times}`
        }
      }
    });
    assert.strictEqual(call(iface, 'Hello', 'world', 3), 'world x3');
  });

  it('receives the caller in a context, which closes #230', () => {
    // The message was already passed after the arguments, but only as an
    // accident of argument order that a handler had to know about.
    let seen;
    const iface = defineInterface({
      name: 'com.example.I',
      methods: {
        Hello: { in: { name: 's' }, handler: (_args, ctx) => (seen = ctx) }
      }
    });
    call(iface, 'Hello', 'x');
    assert.strictEqual(seen.sender, ':1.7');
    assert.strictEqual(seen.path, '/com/example/Obj');
    assert.strictEqual(seen.interface, 'com.example.I');
    assert.strictEqual(seen.member, 'Hello');
    assert.strictEqual(seen.message, MESSAGE);
  });

  it('reads the message from the end, not by declared arity', () => {
    // A peer that sends more arguments than declared should still leave the
    // context intact rather than have the message read as an argument.
    let seen;
    const iface = defineInterface({
      name: 'com.example.I',
      methods: {
        Hello: { in: { name: 's' }, handler: (a, ctx) => (seen = ctx) }
      }
    });
    iface.impl.Hello('x', 'unexpected', MESSAGE);
    assert.strictEqual(seen.sender, ':1.7');
  });

  it('returns a single value directly', async () => {
    const iface = defineInterface({
      name: 'com.example.I',
      methods: {
        One: { out: { only: 's' }, handler: () => 'just this' }
      }
    });
    assert.strictEqual(await call(iface, 'One'), 'just this');
  });

  it('returns several by name, converted to positional', async () => {
    const iface = defineInterface({
      name: 'com.example.I',
      methods: {
        Two: {
          out: { a: 's', b: 'i' },
          handler: () => ({ b: 2, a: 'first' })
        }
      }
    });
    // Declaration order, not the order the handler happened to write them.
    assert.deepStrictEqual(await call(iface, 'Two'), ['first', 2]);
  });

  it('says so when a multi-value handler returns the wrong shape', async () => {
    const iface = defineInterface({
      name: 'com.example.I',
      methods: {
        Two: { out: { a: 's', b: 'i' }, handler: () => 'not an object' }
      }
    });
    await assert.rejects(
      () => Promise.resolve(call(iface, 'Two')),
      /declares 2 return values, so it must return an object keyed by a, b/
    );
  });

  it('awaits an async handler before rearranging its result', async () => {
    const iface = defineInterface({
      name: 'com.example.I',
      methods: {
        Two: {
          out: { a: 's', b: 'i' },
          handler: async () => ({ a: 'x', b: 1 })
        }
      }
    });
    assert.deepStrictEqual(await call(iface, 'Two'), ['x', 1]);
  });
});

describe('defineInterface: properties', () => {
  it('reads and writes through get/set, as stdifaces does', () => {
    let volume = 0.5;
    const iface = defineInterface({
      name: 'com.example.I',
      properties: {
        Volume: {
          type: 'd',
          get: () => volume,
          set: v => {
            volume = v;
          }
        }
      }
    });
    // stdifaces uses plain property access, so an accessor is all it takes.
    assert.strictEqual(iface.impl.Volume, 0.5);
    iface.impl.Volume = 0.9;
    assert.strictEqual(volume, 0.9);
    assert.strictEqual(iface.impl.Volume, 0.9);
  });

  it('stores a plain value when there is no accessor', () => {
    const iface = defineInterface({
      name: 'com.example.I',
      properties: { Greeting: { type: 's', value: 'hello' } }
    });
    assert.strictEqual(iface.impl.Greeting, 'hello');
    iface.impl.Greeting = 'changed';
    assert.strictEqual(iface.impl.Greeting, 'changed');
  });

  it('recomputes a getter every read', () => {
    let n = 0;
    const iface = defineInterface({
      name: 'com.example.I',
      properties: { Count: { type: 'u', access: 'read', get: () => ++n } }
    });
    assert.strictEqual(iface.impl.Count, 1);
    assert.strictEqual(iface.impl.Count, 2);
  });
});

describe('defineInterface: what it refuses', () => {
  const bad = (spec, message) =>
    assert.throws(() => defineInterface(spec), message);

  it('needs a valid interface name', () => {
    bad({ name: 'nodots' }, /interface name/);
    bad({}, /interface name/);
    assert.throws(() => defineInterface(), /needs a definition object/);
  });

  it('needs a handler on every method', () => {
    bad(
      { name: 'com.example.I', methods: { Hello: { in: { a: 's' } } } },
      /needs a handler function/
    );
  });

  it('rejects an unknown key, rather than ignoring it', () => {
    // A typo in a declaration is silent forever otherwise.
    bad(
      {
        name: 'com.example.I',
        methods: { Hello: { handler: () => {}, input: { a: 's' } } }
      },
      /unknown key "input"/
    );
    bad(
      {
        name: 'com.example.I',
        properties: { A: { type: 's', acces: 'read' } }
      },
      /unknown key "acces"/
    );
    bad(
      { name: 'com.example.I', signals: { S: { arguments: {} } } },
      /unknown key "arguments"/
    );
  });

  it('rejects an accessor that contradicts the access', () => {
    bad(
      {
        name: 'com.example.I',
        properties: { A: { type: 's', access: 'read', set: () => {} } }
      },
      /read-only but declares a set/
    );
    bad(
      {
        name: 'com.example.I',
        properties: { A: { type: 's', access: 'write', get: () => 1 } }
      },
      /write-only but declares a get/
    );
  });

  it('rejects a value alongside an accessor', () => {
    bad(
      {
        name: 'com.example.I',
        properties: { A: { type: 's', value: 'x', get: () => 'y' } }
      },
      /use one or the other/
    );
  });

  it('rejects an invalid member name at definition time', () => {
    bad(
      { name: 'com.example.I', methods: { 'not-a-member': () => {} } },
      /not a valid member name/
    );
    bad(
      { name: 'com.example.I', signals: { 'not-a-member': { args: {} } } },
      /not a valid member name/
    );
  });

  it('rejects a non-string signature', () => {
    bad(
      {
        name: 'com.example.I',
        methods: { Hello: { in: { a: 42 }, handler: () => {} } }
      },
      /must be a signature string/
    );
  });

  it('rejects an unknown access', () => {
    bad(
      { name: 'com.example.I', properties: { A: { type: 's', access: 'rw' } } },
      /expected one of read, write, readwrite/
    );
  });
});

describe('defineInterface: emit', () => {
  it('refuses before export rather than silently doing nothing', () => {
    const iface = defineInterface({
      name: 'com.example.I',
      signals: { Greeted: { args: { who: 's' } } }
    });
    // The impl is an EventEmitter, so emitting would otherwise reach its own
    // emit() and go nowhere near the bus.
    assert.throws(
      () => iface.emit.Greeted('world'),
      /has not been exported yet/
    );
  });

  it('has one function per declared signal, and no others', () => {
    const iface = defineInterface({
      name: 'com.example.I',
      signals: { A: { args: {} }, B: { args: { x: 's' } } }
    });
    assert.deepStrictEqual(Object.keys(iface.emit).sort(), ['A', 'B']);
  });
});
