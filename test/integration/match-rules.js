// Does lib/match-rule.js agree with dbus-daemon about what a valid rule is?
//
// The grammar is described in prose rather than given as a formal syntax, so
// the only way to be sure of the edge cases -- what a bare backslash does,
// whether a comma inside quotes is data, whether whitespace around a value is
// allowed -- is to ask the reference implementation. The rules below are the
// corpus that established the current behaviour; a disagreement means either
// our parser drifted or libdbus changed, and both are worth failing over.
//
// This matters for lib/broker.js, which has to accept whatever a client that
// works against dbus-daemon sends it.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { sessionBus } = require('../utils/shape');
const { parse } = require('../../lib/match-rule');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

// Each entry is a rule the daemon is asked to accept or reject.
const CORPUS = [
  '',
  "type='signal'",
  'type=signal',
  "type='shout'",
  "sender='org.freedesktop.DBus'",
  "interface='com.example.I',member='Pinged'",
  "path='/com/example/Obj'",
  "path_namespace='/com/example'",
  "path='/a',path_namespace='/'",
  "destination=':1.9'",
  "arg0='alpha'",
  "arg63='x'",
  "arg64='x'",
  "arg0path='/a/'",
  "arg0namespace='com.example'",
  "nonsense='x'",
  "arg0='a,b'",
  "arg0='a=b'",
  'arg0=a=b',
  "arg0='it'\\''s'",
  'arg0=a\\,b',
  "arg0='a''b'",
  "arg0=''",
  "type='signal',",
  'justakey',
  "arg0='unterminated",
  'arg0=x\\',
  "eavesdrop='true'",
  "eavesdrop='false'",
  "type='signal',eavesdrop='true',arg0namespace='org.freedesktop'",
  "  type='signal'  ",
  "type='signal' , member='X'"
];

describe(
  'integration: match rules vs dbus-daemon',
  { timeout: 30000, skip: NO_BUS },
  () => {
    let bus;

    before(async () => {
      bus = sessionBus();
      await bus.getId();
    });

    after(() => {
      if (bus) bus.connection.end();
    });

    const daemonAccepts = async rule => {
      try {
        await bus.invokeDbus({
          member: 'AddMatch',
          signature: 's',
          body: [rule]
        });
      } catch {
        return false;
      }
      // Take it back off, so a corpus of thirty rules does not leave the daemon
      // matching everything for the rest of the suite.
      await bus
        .invokeDbus({ member: 'RemoveMatch', signature: 's', body: [rule] })
        .catch(() => {});
      return true;
    };

    const weAccept = rule => {
      try {
        parse(rule);
        return true;
      } catch {
        return false;
      }
    };

    it('agrees with the daemon on every rule in the corpus', async () => {
      const disagreements = [];
      for (const rule of CORPUS) {
        const theirs = await daemonAccepts(rule);
        const ours = weAccept(rule);
        if (ours !== theirs) {
          disagreements.push(
            `${JSON.stringify(rule)}: we ${ours ? 'accept' : 'reject'}, ` +
              `the daemon ${theirs ? 'accepts' : 'rejects'}`
          );
        }
      }
      assert.deepStrictEqual(disagreements, []);
    });

    it('rejects the things the daemon rejects, for the reasons we claim', async () => {
      // Spot-check that our refusals are not accidental: the message should name
      // what is wrong, since these become MatchRuleInvalid to a caller.
      const cases = [
        ["type='shout'", /type "shout" is not one of/],
        ["nonsense='x'", /unknown key "nonsense"/],
        ["arg64='x'", /above 63/],
        ["arg0='unterminated", /unterminated quote/],
        ["path='/a',path_namespace='/'", /both path and path_namespace/]
      ];
      for (const [rule, message] of cases) {
        assert.throws(() => parse(rule), { message }, rule);
        assert.strictEqual(await daemonAccepts(rule), false, rule);
      }
    });

    it('delivers a signal the way a rule we parsed says it should', async () => {
      // The other half: not just that the daemon accepts our rules, but that our
      // matcher agrees with the daemon's routing for the same rule.
      const { matches } = require('../../lib/match-rule');
      const rule =
        "type='signal',sender='org.freedesktop.DBus'," +
        "interface='org.freedesktop.DBus',member='NameOwnerChanged'," +
        "arg0='com.example.MatchRuleProbe'";
      await bus.invokeDbus({
        member: 'AddMatch',
        signature: 's',
        body: [rule]
      });

      const delivered = [];
      bus.connection.on('message', msg => {
        if (msg.member === 'NameOwnerChanged') delivered.push(msg);
      });

      const other = sessionBus();
      await other.getId();
      await new Promise((resolve, reject) =>
        other.requestName('com.example.MatchRuleProbe', 0, err =>
          err ? reject(err) : resolve()
        )
      );
      await new Promise(resolve => setTimeout(resolve, 300));
      other.connection.end();

      assert.ok(delivered.length > 0, 'the daemon delivered it');
      const parsed = parse(rule);
      for (const msg of delivered) {
        assert.strictEqual(
          matches(parsed, msg),
          true,
          `we would not have delivered ${JSON.stringify(msg.body)}`
        );
      }
    });
  }
);
