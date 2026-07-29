// Match rules.
//
// https://dbus.freedesktop.org/doc/dbus-specification.html#message-bus-routing-match-rules

const { describe, it } = require('node:test');
const assert = require('assert');
const { parse, matches, tokenize } = require('../lib/match-rule');
const constants = require('../lib/constants');

const signal = (overrides = {}) => ({
  type: constants.messageType.signal,
  sender: ':1.7',
  path: '/com/example/Obj',
  interface: 'com.example.Iface',
  member: 'Pinged',
  body: [],
  ...overrides
});

describe('match rules: parsing', () => {
  it('reads the keys the specification defines', () => {
    const rule = parse(
      "type='signal',sender='org.freedesktop.DBus',interface='com.example.I'," +
        "member='Pinged',path='/com/example/Obj',destination=':1.9'"
    );
    assert.strictEqual(rule.type, 'signal');
    assert.strictEqual(rule.sender, 'org.freedesktop.DBus');
    assert.strictEqual(rule['interface'], 'com.example.I');
    assert.strictEqual(rule.member, 'Pinged');
    assert.strictEqual(rule.path, '/com/example/Obj');
    assert.strictEqual(rule.destination, ':1.9');
  });

  it('reads argN, argNpath and arg0namespace', () => {
    const rule = parse(
      "arg0='first',arg3='fourth',arg1path='/a/b/',arg0namespace='com.example'"
    );
    assert.strictEqual(rule.args.get(0), 'first');
    assert.strictEqual(rule.args.get(3), 'fourth');
    assert.strictEqual(rule.argPaths.get(1), '/a/b/');
    assert.strictEqual(rule.arg0namespace, 'com.example');
  });

  it('treats an empty rule as matching everything', () => {
    const rule = parse('');
    assert.deepStrictEqual(rule.args.size, 0);
    assert.strictEqual(matches(rule, signal()), true);
    assert.strictEqual(
      matches(rule, signal({ type: constants.messageType.methodCall })),
      true
    );
  });

  it('accepts values with no quotes at all', () => {
    // The daemon is lenient here, and plenty of code in the wild writes
    // type=signal without them.
    const rule = parse('type=signal,member=Pinged');
    assert.strictEqual(rule.type, 'signal');
    assert.strictEqual(rule.member, 'Pinged');
  });

  describe('quoting', () => {
    it('keeps a comma inside quotes as data', () => {
      const rule = parse("arg0='a,b',member='X'");
      assert.strictEqual(rule.args.get(0), 'a,b');
      assert.strictEqual(rule.member, 'X');
    });

    it('keeps an equals sign inside quotes as data', () => {
      assert.strictEqual(parse("arg0='a=b'").args.get(0), 'a=b');
    });

    it('takes only the first equals sign as the separator', () => {
      assert.strictEqual(parse('arg0=a=b').args.get(0), 'a=b');
    });

    it("embeds a literal quote by closing the section: it'\\''s", () => {
      assert.strictEqual(parse("arg0='it'\\''s'").args.get(0), "it's");
    });

    it('lets a backslash outside quotes escape the next character', () => {
      assert.strictEqual(parse('arg0=a\\,b').args.get(0), 'a,b');
      assert.strictEqual(parse("arg0=a\\'b").args.get(0), "a'b");
    });

    it('joins adjacent quoted sections', () => {
      assert.strictEqual(parse("arg0='a''b'").args.get(0), 'ab');
    });

    it('allows an empty value', () => {
      assert.strictEqual(parse("arg0=''").args.get(0), '');
    });

    it('drops a backslash at the very end, as libdbus does', () => {
      // Not an error: dbus-daemon accepts this rule, and refusing it would
      // mean a client that works against the daemon fails against our broker.
      assert.strictEqual(parse('arg0=x\\').args.get(0), 'x');
    });

    it('tolerates a trailing comma', () => {
      assert.strictEqual(parse("type='signal',").type, 'signal');
    });

    it('exposes the tokenizer, because the quoting is the fiddly part', () => {
      assert.deepStrictEqual(tokenize("a='1',b='2'"), [
        ['a', '1'],
        ['b', '2']
      ]);
    });
  });

  describe('what it refuses', () => {
    const bad = [
      ["type='shout'", /type "shout" is not one of/],
      ["nonsense='x'", /unknown key "nonsense"/],
      ["arg64='x'", /argument index 64 is above 63/],
      ["arg0='unterminated", /unterminated quote/],
      ["path='/a',path_namespace='/'", /both path and path_namespace/],
      ["path_namespace='/',path='/a'", /both path and path_namespace/],
      ['justakey', /key with no value/]
    ];
    for (const [rule, message] of bad) {
      it(`refuses ${JSON.stringify(rule)}`, () =>
        assert.throws(() => parse(rule), { message }));
    }

    it('refuses a rule that is not a string', () => {
      assert.throws(() => parse(42), /must be a string/);
    });
  });
});

describe('match rules: matching', () => {
  it('matches on type', () => {
    assert.strictEqual(matches("type='signal'", signal()), true);
    assert.strictEqual(matches("type='method_call'", signal()), false);
  });

  it('matches on sender, interface, member, path and destination', () => {
    const msg = signal({ destination: ':1.9' });
    assert.strictEqual(matches("sender=':1.7'", msg), true);
    assert.strictEqual(matches("sender=':1.8'", msg), false);
    assert.strictEqual(matches("interface='com.example.Iface'", msg), true);
    assert.strictEqual(matches("member='Pinged'", msg), true);
    assert.strictEqual(matches("member='Ponged'", msg), false);
    assert.strictEqual(matches("path='/com/example/Obj'", msg), true);
    assert.strictEqual(matches("destination=':1.9'", msg), true);
    assert.strictEqual(matches("destination=':1.1'", msg), false);
  });

  it('requires every key present in the rule to match', () => {
    const rule = "type='signal',member='Pinged',path='/com/example/Obj'";
    assert.strictEqual(matches(rule, signal()), true);
    assert.strictEqual(matches(rule, signal({ member: 'Other' })), false);
  });

  describe('path_namespace', () => {
    it('matches the namespace itself and anything under it', () => {
      const rule = "path_namespace='/com/example'";
      assert.strictEqual(matches(rule, signal({ path: '/com/example' })), true);
      assert.strictEqual(
        matches(rule, signal({ path: '/com/example/Obj' })),
        true
      );
      assert.strictEqual(
        matches(rule, signal({ path: '/com/example/a/b/c' })),
        true
      );
    });

    it('stops at a path separator, not at a character', () => {
      // The trap a plain startsWith falls into.
      assert.strictEqual(
        matches(
          "path_namespace='/com/example'",
          signal({ path: '/com/exampleX' })
        ),
        false
      );
    });

    it("treats '/' as everything", () => {
      assert.strictEqual(matches("path_namespace='/'", signal()), true);
    });
  });

  describe('argN', () => {
    it('matches a string argument exactly', () => {
      const msg = signal({ body: ['alpha', 'beta'] });
      assert.strictEqual(matches("arg0='alpha'", msg), true);
      assert.strictEqual(matches("arg1='beta'", msg), true);
      assert.strictEqual(matches("arg1='alpha'", msg), false);
      assert.strictEqual(matches("arg0='alpha',arg1='beta'", msg), true);
    });

    it('does not match a missing argument', () => {
      assert.strictEqual(matches("arg2='x'", signal({ body: ['a'] })), false);
    });

    it('does not match a non-string argument', () => {
      // The spec restricts argN to STRING, OBJECT_PATH and SIGNATURE.
      assert.strictEqual(matches("arg0='7'", signal({ body: [7] })), false);
      assert.strictEqual(
        matches("arg0='true'", signal({ body: [true] })),
        false
      );
    });
  });

  describe('argNpath', () => {
    it('matches an exact path', () => {
      const msg = signal({ body: ['/a/b'] });
      assert.strictEqual(matches("arg0path='/a/b'", msg), true);
    });

    it('matches when the rule is a prefix of the argument', () => {
      assert.strictEqual(
        matches("arg0path='/a/'", signal({ body: ['/a/b/c'] })),
        true
      );
    });

    it('matches when the argument is a prefix of the rule', () => {
      // Both directions, which is what lets a watcher and a sender agree on a
      // subtree without knowing which is more specific.
      assert.strictEqual(
        matches("arg0path='/a/b/c'", signal({ body: ['/a/'] })),
        true
      );
    });

    it('does not match an unrelated path', () => {
      assert.strictEqual(
        matches("arg0path='/a/'", signal({ body: ['/z/b'] })),
        false
      );
    });
  });

  describe('arg0namespace', () => {
    it('matches the name itself and anything below it', () => {
      const rule = "arg0namespace='com.example'";
      assert.strictEqual(
        matches(rule, signal({ body: ['com.example'] })),
        true
      );
      assert.strictEqual(
        matches(rule, signal({ body: ['com.example.Service'] })),
        true
      );
    });

    it('stops at a dot, not at a character', () => {
      assert.strictEqual(
        matches(
          "arg0namespace='com.example'",
          signal({ body: ['com.exampleX'] })
        ),
        false
      );
    });
  });

  it('accepts a pre-parsed rule, so routing parses once', () => {
    const rule = parse("type='signal',member='Pinged'");
    assert.strictEqual(matches(rule, signal()), true);
    assert.strictEqual(matches(rule, signal({ member: 'Nope' })), false);
  });

  it('matches a NameOwnerChanged rule of the shape everyone writes', () => {
    const rule = parse(
      "type='signal',sender='org.freedesktop.DBus'," +
        "interface='org.freedesktop.DBus',member='NameOwnerChanged'," +
        "arg0='com.example.Watched'"
    );
    const msg = signal({
      sender: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member: 'NameOwnerChanged',
      body: ['com.example.Watched', '', ':1.42']
    });
    assert.strictEqual(matches(rule, msg), true);
    assert.strictEqual(
      matches(rule, { ...msg, body: ['com.example.Other', '', ':1.42'] }),
      false
    );
  });
});
