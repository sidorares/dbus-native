// The D-Bus naming rules, and the places we enforce them.
//
// https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names

const { describe, it } = require('node:test');
const assert = require('assert');
const { Duplex } = require('stream');
const marshall = require('../lib/marshall');
const dbus = require('../index');
const {
  isValidObjectPath,
  isValidInterfaceName,
  isValidErrorName,
  isValidMemberName,
  isValidPropertyName,
  isValidBusName,
  assertValidName
} = require('../lib/names');

const longName = `a.${'b'.repeat(300)}`;

describe('names', () => {
  describe('object paths', () => {
    const valid = [
      '/',
      '/a',
      '/org/freedesktop/DBus',
      '/com/example/Obj_1',
      '/0', // elements may start with a digit, unlike interface names
      `/${'a'.repeat(1000)}` // no length limit in the spec
    ];
    const invalid = [
      ['', 'empty'],
      ['a/b', 'no leading slash'],
      ['/a/', 'trailing slash'],
      ['//', 'empty element'],
      ['/a//b', 'empty element in the middle'],
      ['/a.b', 'dot is not allowed'],
      ['/a-b', 'hyphen is not allowed'],
      ['/a b', 'space is not allowed'],
      [42, 'not a string'],
      [null, 'null'],
      [undefined, 'undefined']
    ];

    for (const path of valid) {
      it(`accepts ${JSON.stringify(path).slice(0, 30)}`, () =>
        assert.strictEqual(isValidObjectPath(path), true));
    }
    for (const [path, why] of invalid) {
      it(`rejects ${JSON.stringify(path)} (${why})`, () =>
        assert.strictEqual(isValidObjectPath(path), false));
    }
  });

  describe('interface and error names', () => {
    const valid = [
      'a.b',
      'org.freedesktop.DBus',
      'com.example.My_Iface',
      '_a._b',
      `a.${'b'.repeat(252)}` // exactly 255 bytes
    ];
    const invalid = [
      ['', 'empty'],
      ['NoDot', 'a single element'],
      ['.a.b', 'leading dot'],
      ['a.b.', 'trailing dot'],
      ['a..b', 'empty element'],
      ['1a.b', 'element starting with a digit'],
      ['a.1b', 'later element starting with a digit'],
      ['a-b.c', 'hyphen (allowed in bus names, not here)'],
      [longName, 'over 255 bytes'],
      [42, 'not a string']
    ];

    for (const name of valid) {
      it(`accepts ${name.slice(0, 30)}`, () =>
        assert.strictEqual(isValidInterfaceName(name), true));
    }
    for (const [name, why] of invalid) {
      it(`rejects ${JSON.stringify(name).slice(0, 30)} (${why})`, () =>
        assert.strictEqual(isValidInterfaceName(name), false));
    }

    it('applies the same rules to error names', () => {
      assert.strictEqual(
        isValidErrorName('org.freedesktop.DBus.Error.Failed'),
        true
      );
      assert.strictEqual(isValidErrorName('Failed'), false);
    });
  });

  describe('member names', () => {
    for (const name of ['a', 'Ping', '_private', 'Get2'])
      it(`accepts ${name}`, () =>
        assert.strictEqual(isValidMemberName(name), true));

    const invalid = [
      ['', 'empty'],
      ['a.b', 'dots are not allowed'],
      ['1a', 'starting with a digit'],
      ['a-b', 'hyphen'],
      ['b'.repeat(256), 'over 255 bytes']
    ];
    for (const [name, why] of invalid)
      it(`rejects ${JSON.stringify(name).slice(0, 20)} (${why})`, () =>
        assert.strictEqual(isValidMemberName(name), false));
  });

  describe('property names', () => {
    // Looser than member names by exactly one character. The spec does not
    // cover property names at all, and GObject-derived services use '-'.
    for (const name of [
      'a',
      'Greeting',
      '_private',
      'Get2',
      'my-prop',
      'a-b-c'
    ])
      it(`accepts ${name}`, () =>
        assert.strictEqual(isValidPropertyName(name), true));

    const invalid = [
      ['', 'empty'],
      ['a.b', 'dots are not allowed'],
      ['1a', 'starting with a digit'],
      ['-a', 'starting with a hyphen'],
      ['a b', 'space'],
      ['a"b', 'a quote would break the introspection XML'],
      ['a<b', 'a bracket would break the introspection XML'],
      [42, 'not a string'],
      ['b'.repeat(256), 'over 255 bytes']
    ];
    for (const [name, why] of invalid)
      it(`rejects ${JSON.stringify(name).slice(0, 20)} (${why})`, () =>
        assert.strictEqual(isValidPropertyName(name), false));

    it('is exported from the package entry point', () => {
      assert.strictEqual(dbus.isValidPropertyName('my-prop'), true);
      assert.strictEqual(dbus.isValidMemberName('my-prop'), false);
    });
  });

  describe('bus names', () => {
    const valid = [
      'org.freedesktop.DBus',
      'com.example.my-service', // hyphens are allowed here but not in interfaces
      ':1.23', // unique name
      ':1.0',
      ':a'
    ];
    const invalid = [
      ['', 'empty'],
      ['NoDot', 'a single element'],
      ['1a.b', 'well-known element starting with a digit'],
      ['.a.b', 'leading dot'],
      [':', 'just a colon'],
      [':1..2', 'empty element']
    ];

    for (const name of valid)
      it(`accepts ${name}`, () =>
        assert.strictEqual(isValidBusName(name), true));
    for (const [name, why] of invalid)
      it(`rejects ${JSON.stringify(name)} (${why})`, () =>
        assert.strictEqual(isValidBusName(name), false));
  });

  describe('assertValidName', () => {
    it('returns the value when it is valid', () => {
      assert.strictEqual(assertValidName('interface name', 'a.b'), 'a.b');
    });

    it('names the rule that was broken', () => {
      assert.throws(() => assertValidName('interface name', 'NoDot'), {
        message: /Invalid interface name: "NoDot" -- must be two or more/
      });
    });

    it('includes the context when given one', () => {
      assert.throws(
        () => assertValidName('member name', '1bad', 'methods.1bad'),
        { message: /for methods\.1bad/ }
      );
    });
  });
});

describe('marshalling an object path', () => {
  it('accepts a valid path', () => {
    assert.doesNotThrow(() => marshall('o', ['/a/b']));
  });

  it('rejects a path with no leading slash', () => {
    assert.throws(() => marshall('o', ['invalid/object/path']), {
      message: /is not a valid object path/
    });
  });

  it('rejects a path with a trailing slash', () => {
    assert.throws(() => marshall('o', ['/a/']), {
      message: /is not a valid object path/
    });
  });

  it('rejects a path containing a dot', () => {
    assert.throws(() => marshall('o', ['/com.example/Obj']), {
      message: /is not a valid object path/
    });
  });

  it('still rejects a non-string, with the same error a plain string gives', () => {
    assert.throws(() => marshall('o', [42]), {
      message: /Expected string or buffer argument, got 42 of type 'o'/
    });
  });

  it('does not constrain plain strings', () => {
    assert.doesNotThrow(() => marshall('s', ['invalid/object/path']));
  });
});

class FakeSocket extends Duplex {
  _write(chunk, enc, cb) {
    cb();
  }
  _read() {}
}

// Complete the SASL handshake by hand so the bus reaches 'connect'. `direct`
// skips the Hello call, which needs a daemon to answer.
function connectBus() {
  return new Promise(resolve => {
    const socket = new FakeSocket();
    const bus = dbus.createClient({ stream: socket, direct: true });
    setImmediate(() => socket.push('OK 0123456789abcdef\r\n'));
    bus.connection.once('connect', () => resolve(bus));
  });
}

const okDesc = {
  name: 'com.example.Iface',
  methods: { Ping: ['', ''] },
  signals: { Pinged: ['s', 'who'] },
  properties: { Greeting: 's' }
};

describe('exportInterface validates what it is given', () => {
  const withDesc = overrides => ({ ...okDesc, ...overrides });

  it('accepts a well-formed export', async () => {
    const bus = await connectBus();
    assert.doesNotThrow(() =>
      bus.exportInterface({}, '/com/example/Obj', okDesc)
    );
    bus.connection.end();
  });

  const cases = [
    [
      'an invalid object path',
      'com/example/Obj',
      okDesc,
      /Invalid object path/
    ],
    [
      'an interface name with no dot',
      '/com/example/Obj',
      withDesc({ name: 'Iface' }),
      /Invalid interface name for the interface descriptor/
    ],
    [
      'a method name containing a dot',
      '/com/example/Obj',
      withDesc({ methods: { 'a.b': ['', ''] } }),
      /Invalid member name for methods\.a\.b/
    ],
    [
      'a signal name starting with a digit',
      '/com/example/Obj',
      withDesc({ signals: { '1Pinged': ['s', 'who'] } }),
      /Invalid member name for signals\.1Pinged/
    ],
    [
      'a property name containing a dot',
      '/com/example/Obj',
      withDesc({ properties: { 'a.b': 's' } }),
      /Invalid property name for properties\.a\.b/
    ],
    [
      'a property name containing a space',
      '/com/example/Obj',
      withDesc({ properties: { 'my prop': 's' } }),
      /Invalid property name for properties\.my prop/
    ]
  ];

  for (const [why, path, desc, message] of cases) {
    it(`rejects ${why}`, async () => {
      const bus = await connectBus();
      assert.throws(() => bus.exportInterface({}, path, desc), { message });
      bus.connection.end();
    });
  }

  // 0.11.0 applied the member-name rules to property names and broke this.
  // GDBus, sd-bus and python-dbus all read and write a hyphenated property
  // without complaint, and '-' is the GObject convention.
  it("accepts a property name containing '-', unlike a member name", async () => {
    const bus = await connectBus();
    assert.doesNotThrow(() =>
      bus.exportInterface(
        {},
        '/com/example/Obj',
        withDesc({ properties: { 'my-prop': 's', 'a-b-c': { type: 'b' } } })
      )
    );
    assert.throws(
      () =>
        bus.exportInterface(
          {},
          '/com/example/Obj',
          withDesc({ methods: { 'my-method': ['', ''] } })
        ),
      /Invalid member name for methods\.my-method/
    );
    bus.connection.end();
  });

  it('does not half-export an object it then rejects', async () => {
    const bus = await connectBus();
    assert.throws(() =>
      bus.exportInterface({}, '/com/example/Obj', withDesc({ name: 'Iface' }))
    );
    assert.strictEqual(bus.exportedObjects['/com/example/Obj'], undefined);
    bus.connection.end();
  });
});

describe('sendSignal validates what it emits', () => {
  // Signals get no reply, so an unroutable one is silent -- worth catching
  // even though the equivalent method call would produce an error.
  it('accepts a well-formed signal', async () => {
    const bus = await connectBus();
    assert.doesNotThrow(() =>
      bus.sendSignal('/com/example/Obj', 'com.example.Iface', 'Pinged', 's', [
        'hi'
      ])
    );
    bus.connection.end();
  });

  it('rejects an interface name with no dot', async () => {
    const bus = await connectBus();
    assert.throws(() => bus.sendSignal('/com/example/Obj', 'Iface', 'Pinged'), {
      message: /Invalid interface name for the signal interface/
    });
    bus.connection.end();
  });

  it('rejects a member name containing a dot', async () => {
    const bus = await connectBus();
    assert.throws(
      () => bus.sendSignal('/com/example/Obj', 'com.example.Iface', 'a.b'),
      { message: /Invalid member name for the signal name/ }
    );
    bus.connection.end();
  });

  it('rejects an invalid object path, through the marshaller', async () => {
    const bus = await connectBus();
    assert.throws(
      () => bus.sendSignal('bad/path', 'com.example.Iface', 'Pinged'),
      { message: /is not a valid object path/ }
    );
    bus.connection.end();
  });
});

describe('sendError validates the error name', () => {
  const aCall = { serial: 1, sender: ':1.2' };

  it('accepts a well-formed error name', async () => {
    const bus = await connectBus();
    assert.doesNotThrow(() =>
      bus.sendError(aCall, 'com.example.Error.Failed', 'boom')
    );
    bus.connection.end();
  });

  it('rejects a name with no dot, which a peer could not route', async () => {
    const bus = await connectBus();
    assert.throws(() => bus.sendError(aCall, 'Failed', 'boom'), {
      message: /Invalid error name: "Failed"/
    });
    bus.connection.end();
  });

  it('rejects a missing name rather than sending it', async () => {
    const bus = await connectBus();
    assert.throws(() => bus.sendError(aCall, undefined, 'boom'), {
      message: /Invalid error name/
    });
    bus.connection.end();
  });
});
