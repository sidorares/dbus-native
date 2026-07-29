// The bus-facing CLI, run as a command against a real bus.
//
// Unit tests cover the argument grammar; this covers the part that only shows
// up when the binary actually runs -- that it connects, that a reply renders,
// that a failure exits non-zero with the error name on it.
//
// Every spawn is async on purpose: the test process is also the service under
// test, so blocking the event loop would mean the CLI's call never gets an
// answer.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const { EventEmitter } = require('events');
const dbus = require('../../index');

const run = promisify(execFile);
const BIN = path.join(__dirname, '..', '..', 'bin', 'dbus-native.js');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Cli';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/Cli';
const IFACE = 'com.github.sidorares.dbusnative.CliIface';

const cli = args => run(process.execPath, [BIN, ...args], { encoding: 'utf8' });

describe('integration: the CLI', { timeout: 30000, skip: NO_BUS }, () => {
  let bus, impl;

  before(async () => {
    // returnBigInt because one of these echoes a 64-bit value straight back.
    // Without it the service reads `t` as a Number, which is lossy above 2^53,
    // and then cannot marshal it again -- the CLI sends the value exactly, and
    // it is the echo that would lose it.
    bus = dbus.sessionBus({ returnBigInt: true });
    await bus.getId();
    await new Promise((resolve, reject) =>
      bus.requestName(SERVICE, 0, err => (err ? reject(err) : resolve()))
    );
    impl = Object.assign(Object.create(EventEmitter.prototype), {
      Echo: text => text,
      Add: (a, b) => a + b,
      Big: value => value,
      Tags: parts => parts.join('|'),
      Greeting: 'hello',
      Locked: true
    });
    EventEmitter.call(impl);
    bus.exportInterface(impl, OBJECT_PATH, {
      name: IFACE,
      methods: {
        Echo: ['s', 's', ['text'], ['out']],
        Add: ['uu', 'u', ['a', 'b'], ['sum']],
        Big: ['t', 't', ['value'], ['out']],
        Tags: ['as', 's', ['parts'], ['out']]
      },
      signals: {},
      properties: {
        Greeting: 's',
        Locked: { type: 'b', access: 'read' }
      }
    });
  });

  after(() => {
    if (bus) bus.connection.end();
  });

  describe('call', () => {
    it('calls a method with no arguments', async () => {
      const { stdout } = await cli([
        'call',
        '--dest',
        'org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus.GetId'
      ]);
      assert.match(stdout, /reply s/);
      assert.match(stdout, /"[0-9a-f]{32}"/);
    });

    it('passes type:value arguments through', async () => {
      const { stdout } = await cli([
        'call',
        '--dest',
        SERVICE,
        OBJECT_PATH,
        `${IFACE}.Echo`,
        'string:hello from the cli'
      ]);
      assert.match(stdout, /"hello from the cli"/);
    });

    it('passes several arguments, with their types', async () => {
      const { stdout } = await cli([
        'call',
        '--dest',
        SERVICE,
        OBJECT_PATH,
        `${IFACE}.Add`,
        'uint32:20',
        'uint32:22'
      ]);
      assert.match(stdout, /reply u/);
      assert.match(stdout, /42/);
    });

    it('carries a 64-bit value the CLI could not hold as a number', async () => {
      const { stdout } = await cli([
        'call',
        '--dest',
        SERVICE,
        OBJECT_PATH,
        `${IFACE}.Big`,
        'uint64:18446744073709551615'
      ]);
      assert.match(stdout, /18446744073709551615/);
    });

    it('passes an array', async () => {
      const { stdout } = await cli([
        'call',
        '--dest',
        SERVICE,
        OBJECT_PATH,
        `${IFACE}.Tags`,
        'array:string:a,b,c'
      ]);
      assert.match(stdout, /"a\|b\|c"/);
    });

    it('prints JSON when asked', async () => {
      const { stdout } = await cli([
        'call',
        '--json',
        '--dest',
        SERVICE,
        OBJECT_PATH,
        `${IFACE}.Echo`,
        'string:as json'
      ]);
      assert.strictEqual(JSON.parse(stdout), 'as json');
    });

    it('renders a dict reply readably', async () => {
      const { stdout } = await cli([
        'call',
        '--dest',
        'org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus.GetConnectionCredentials',
        'string:org.freedesktop.DBus'
      ]);
      assert.match(stdout, /reply a\{sv\}/);
      assert.match(stdout, /"UnixUserID" -> variant u \d+/);
    });

    it('takes --signature and --body for what type:value cannot say', async () => {
      const { stdout } = await cli([
        'call',
        '--signature',
        's',
        '--body',
        JSON.stringify(['via json']),
        '--dest',
        SERVICE,
        OBJECT_PATH,
        `${IFACE}.Echo`
      ]);
      assert.match(stdout, /"via json"/);
    });

    it('refuses both forms at once', async () => {
      await assert.rejects(
        () =>
          cli([
            'call',
            '--signature',
            's',
            '--body',
            '["x"]',
            '--dest',
            SERVICE,
            OBJECT_PATH,
            `${IFACE}.Echo`,
            'string:y'
          ]),
        err => {
          assert.match(err.stderr, /not both/);
          return true;
        }
      );
    });

    it('exits non-zero on a d-bus error, naming it', async () => {
      await assert.rejects(
        () =>
          cli([
            'call',
            '--dest',
            SERVICE,
            OBJECT_PATH,
            `${IFACE}.NoSuchMethod`
          ]),
        err => {
          assert.strictEqual(err.code, 1);
          assert.match(err.stderr, /org\.freedesktop\.DBus\.Error\./);
          return true;
        }
      );
    });

    it('exits non-zero on a bad argument, before connecting', async () => {
      await assert.rejects(
        () =>
          cli([
            'call',
            '--dest',
            SERVICE,
            OBJECT_PATH,
            `${IFACE}.Echo`,
            'byte:999'
          ]),
        err => {
          assert.match(err.stderr, /out of range for y/);
          return true;
        }
      );
    });

    it('says what it needs when --dest is missing', async () => {
      await assert.rejects(
        () => cli(['call', OBJECT_PATH, `${IFACE}.Echo`]),
        err => {
          assert.match(err.stderr, /Need --dest/);
          return true;
        }
      );
    });

    it('says what it needs when the member is not qualified', async () => {
      await assert.rejects(
        () => cli(['call', '--dest', SERVICE, OBJECT_PATH, 'Echo']),
        err => {
          assert.match(err.stderr, /Expected INTERFACE\.MEMBER/);
          return true;
        }
      );
    });
  });

  describe('get and set', () => {
    it('reads a property', async () => {
      const { stdout } = await cli([
        'get',
        '--dest',
        SERVICE,
        OBJECT_PATH,
        IFACE,
        'Greeting'
      ]);
      assert.match(stdout, /variant s "hello"/);
    });

    it('reads a property as JSON', async () => {
      const { stdout } = await cli([
        'get',
        '--json',
        '--dest',
        SERVICE,
        OBJECT_PATH,
        IFACE,
        'Greeting'
      ]);
      assert.strictEqual(JSON.parse(stdout), 'hello');
    });

    it('writes a property, and says nothing on success', async () => {
      const { stdout } = await cli([
        'set',
        '--dest',
        SERVICE,
        OBJECT_PATH,
        IFACE,
        'Greeting',
        'string:written by the cli'
      ]);
      assert.strictEqual(stdout.trim(), '');
      assert.strictEqual(impl.Greeting, 'written by the cli');
    });

    it('reports a write to a read-only property', async () => {
      await assert.rejects(
        () =>
          cli([
            'set',
            '--dest',
            SERVICE,
            OBJECT_PATH,
            IFACE,
            'Locked',
            'boolean:false'
          ]),
        err => {
          assert.match(err.stderr, /PropertyReadOnly/);
          return true;
        }
      );
      assert.strictEqual(impl.Locked, true);
    });

    it('needs a type on the value it is given', async () => {
      await assert.rejects(
        () =>
          cli([
            'set',
            '--dest',
            SERVICE,
            OBJECT_PATH,
            IFACE,
            'Greeting',
            'oops'
          ]),
        err => {
          assert.match(err.stderr, /Missing value after "s"|Unknown type/);
          return true;
        }
      );
    });
  });

  describe('list', () => {
    it('lists the well-known names', async () => {
      const { stdout } = await cli(['list']);
      assert.match(stdout, /org\.freedesktop\.DBus/);
      assert.match(stdout, new RegExp(SERVICE.replace(/\./g, '\\.')));
      assert.doesNotMatch(stdout, /^:\d/m, 'unique names hidden by default');
    });

    it('includes unique names with --all', async () => {
      const { stdout } = await cli(['list', '--all']);
      assert.match(stdout, /^:\d+\.\d+$/m);
    });

    it('lists activatable names', async () => {
      // A private bus has none, so the check is that it asks the right question
      // and exits cleanly rather than that anything comes back.
      const { stdout } = await cli(['list', '--activatable', '--json']);
      assert.ok(Array.isArray(JSON.parse(stdout)));
    });
  });
});
