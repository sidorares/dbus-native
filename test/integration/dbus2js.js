// dbus2js is deprecated but still published, so its remaining bugs are fixed
// and pinned here. Each case is something it got wrong before 0.7.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { EventEmitter } = require('events');
const { sessionBus } = require('../utils/shape');

// node:test skips a whole suite from its options, evaluated at load time.
const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const run = promisify(execFile);

const SERVICE = 'com.github.sidorares.dbusnative.Legacy';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/Legacy';
const IFACE = 'com.github.sidorares.dbusnative.LegacyIface';

const REPO = path.join(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin/dbus2js.js');

describe(
  'integration: dbus2js (deprecated)',
  { timeout: 60000, skip: NO_BUS },
  () => {
    let serviceBus;
    let tmp;

    before(async () => {
      serviceBus = sessionBus();
      const impl = Object.assign(Object.create(EventEmitter.prototype), {
        Greeting: 'hello',
        Echo: s => s
      });
      EventEmitter.call(impl);
      await serviceBus.getId();
      await serviceBus.requestName(SERVICE, 0);
      serviceBus.exportInterface(impl, OBJECT_PATH, {
        name: IFACE,
        methods: { Echo: ['s', 's', ['input'], ['output']] },
        signals: { Pinged: ['s', 'who'] },
        // a property, which is what used to corrupt the output
        properties: { Greeting: 's' }
      });
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus2js-'));
    });

    after(() => {
      if (serviceBus) serviceBus.connection.end();
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    const dbus2js = (args, opts = {}) =>
      run(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        env: process.env,
        ...opts
      });

    it('warns on stderr and keeps stdout valid JavaScript', async () => {
      const { stdout, stderr } = await dbus2js([
        '--service',
        SERVICE,
        '--path',
        OBJECT_PATH
      ]);

      assert.match(stderr, /DBUS_DEP0005/);
      assert.match(stderr, /deprecated/);
      // the suggested command is built from the arguments actually given
      assert.match(stderr, /npx dbus-native types/);
      assert.match(stderr, new RegExp(`--service ${SERVICE}`));
      assert.match(stderr, new RegExp(`--path ${OBJECT_PATH}`));
      assert.match(stderr, /deprecations\.md#dbus_dep0005/);

      // properties are reported, but on stderr -- this used to land in stdout
      assert.match(stderr, /properties not generated \(Greeting\)/);
      assert.doesNotMatch(stdout, /Greeting/);

      // and the actual point: the output parses
      const file = path.join(tmp, 'client.js');
      fs.writeFileSync(file, stdout);
      await run(process.execPath, ['--check', file]);
    });

    it('generates a usable client module', async () => {
      const { stdout } = await dbus2js([
        '--service',
        SERVICE,
        '--path',
        OBJECT_PATH
      ]);
      const file = path.join(tmp, 'usable.js');
      fs.writeFileSync(file, stdout);

      const script = `
      const dbus = require(${JSON.stringify(REPO)});
      const mod = require(${JSON.stringify(file)});
      const bus = dbus.sessionBus();
      const Iface = mod[${JSON.stringify(IFACE)}];
      const iface = new Iface(bus);
      iface.Echo('round trip', (err, out) => {
        if (err) { console.error('ERR', err); process.exit(1); }
        console.log('got:' + out);
        process.exit(0);
      });
    `;
      const { stdout: out } = await run(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: process.env
      });
      assert.match(out, /got:round trip/);
    });

    it('narrows the generated match rule to path and interface', async () => {
      const { stdout } = await dbus2js([
        '--service',
        SERVICE,
        '--path',
        OBJECT_PATH
      ]);
      // it used to emit type='signal',member='X' only, which asks the daemon for
      // that signal name from every service on the bus
      assert.match(stdout, new RegExp(`path='${OBJECT_PATH}'`));
      assert.match(stdout, new RegExp(`interface='${IFACE}'`));
    });

    it('--dump prints only the xml, not the xml and a module', async () => {
      const { stdout } = await dbus2js([
        '--service',
        SERVICE,
        '--path',
        OBJECT_PATH,
        '--dump'
      ]);
      assert.match(stdout, /<interface name="com\.github\.sidorares/);
      assert.doesNotMatch(stdout, /module\.exports/);
    });

    // #148
    it('does not crash on a node with no interfaces', async () => {
      const xmlFile = path.join(tmp, 'empty.xml');
      fs.writeFileSync(xmlFile, '<node><node name="child"/></node>');
      const { stdout, stderr } = await dbus2js(['--xml', xmlFile]);
      assert.match(stderr, /no interfaces/);
      assert.strictEqual(stdout.trim(), '');
    });

    it('fails cleanly when --service and --path are missing', async () => {
      await assert.rejects(
        () => dbus2js([]),
        err => {
          assert.strictEqual(err.code, 1); // was -1, i.e. 255
          assert.match(err.stderr, /Need --service and --path/);
          return true;
        }
      );
    });

    it('times out instead of hanging on a service that never answers', async () => {
      const started = Date.now();
      await assert.rejects(
        () =>
          dbus2js([
            '--service',
            'com.example.NobodyHome',
            '--path',
            '/x',
            '--timeout',
            '500'
          ]),
        err => {
          assert.strictEqual(err.code, 1);
          return true;
        }
      );
      assert.ok(Date.now() - started < 20000, 'should not have hung');
    });
  }
);
