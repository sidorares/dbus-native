// A service written with dbus-native, consumed by other implementations.
//
// This is the direction the unit tests cannot cover: whether GDBus, sd-bus and
// python-dbus can introspect, call, read, write and subscribe to what we
// export. Every external command runs async on purpose -- execFileSync would
// block the event loop, and our own service would never answer.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { EventEmitter } = require('events');
const { session, eventually, close } = require('./helpers');

const run = promisify(execFile);

const SERVICE = 'com.example.E2EService';
const ROOT = '/com/example/E2EService';
const IFACE = 'com.example.E2EIface';

const gdbus = args => run('gdbus', args, { encoding: 'utf8' });
// --address rather than --user: there is no systemd user session in the
// container, so busctl would go looking for $XDG_RUNTIME_DIR/bus.
const busctl = args =>
  run(
    'busctl',
    [
      `--address=${process.env.DBUS_SESSION_BUS_ADDRESS}`,
      '--no-pager',
      ...args
    ],
    { encoding: 'utf8' }
  );

describe(
  'our service, seen by other implementations',
  { timeout: 60000 },
  () => {
    let bus, impl;

    before(async () => {
      bus = session();
      await bus.getId();
      await new Promise((resolve, reject) =>
        bus.requestName(SERVICE, 0, err => (err ? reject(err) : resolve()))
      );

      impl = Object.assign(Object.create(EventEmitter.prototype), {
        Echo: text => text,
        Add: (a, b) => a + b,
        Concat: parts => parts.join('|'),
        Describe: () => [
          ['name', ['s', 'e2e']],
          ['count', ['u', 7]]
        ],
        Greeting: 'hello',
        Locked: true,
        'my-prop': 'hyphens work'
      });
      EventEmitter.call(impl);

      bus.exportInterface(impl, ROOT, {
        name: IFACE,
        methods: {
          Echo: ['s', 's', ['text'], ['echoed']],
          Add: ['uu', 'u', ['a', 'b'], ['sum']],
          Concat: ['as', 's', ['parts'], ['joined']],
          // An argument name that has to be escaped in the introspection XML.
          Describe: ['', 'a{sv}', [], ['fields & more']]
        },
        signals: { Pinged: ['s', 'who'] },
        properties: {
          Greeting: 's',
          Locked: { type: 'b', access: 'read' },
          // Rejected outright before 0.11.1.
          'my-prop': 's'
        }
      });

      // A small tree, so the child-node listing can be checked from outside.
      for (const child of ['Alpha', 'Beta']) {
        const leaf = Object.assign(Object.create(EventEmitter.prototype), {
          Who: () => child
        });
        EventEmitter.call(leaf);
        bus.exportInterface(leaf, `${ROOT}/${child}`, {
          name: `${IFACE}.Child`,
          methods: { Who: ['', 's', [], ['name']] },
          signals: {},
          properties: {}
        });
      }
    });

    after(() => close(bus));

    it('is introspectable by GDBus, arg names and all', async () => {
      const { stdout } = await gdbus([
        'introspect',
        '--session',
        '--dest',
        SERVICE,
        '--object-path',
        ROOT
      ]);
      assert.match(stdout, /interface com\.example\.E2EIface/);
      assert.match(stdout, /Echo\(/);
      assert.match(stdout, /my-prop/, 'a hyphenated property survives');
      // GDBus parsed the document, which it could not have done if the '&' in
      // the arg name had gone in unescaped.
      assert.match(stdout, /Describe/);
      console.log(
        stdout
          .split('\n')
          .filter(l => /interface|readwrite|readonly|\(/.test(l))
          .slice(0, 14)
          .map(l => `      ${l.trim()}`)
          .join('\n')
      );
    });

    it('is introspectable by sd-bus', async () => {
      const { stdout } = await busctl(['introspect', SERVICE, ROOT]);
      assert.match(stdout, /com\.example\.E2EIface/);
      assert.match(stdout, /\.my-prop\s+property/);
      assert.match(stdout, /\.Echo\s+method/);
    });

    it('advertises its children, so sd-bus can draw the tree', async () => {
      const { stdout } = await busctl(['tree', SERVICE]);
      console.log(
        stdout
          .split('\n')
          .map(l => `      ${l}`)
          .join('\n')
      );
      assert.match(stdout, /\/com\/example\/E2EService/);
      assert.match(stdout, /Alpha/, 'the first child is listed');
      assert.match(stdout, /Beta/, 'and so is the second');
    });

    it('answers method calls from GDBus', async () => {
      const echo = await gdbus([
        'call',
        '--session',
        '--dest',
        SERVICE,
        '--object-path',
        ROOT,
        '--method',
        `${IFACE}.Echo`,
        'hello from gdbus'
      ]);
      assert.match(echo.stdout, /hello from gdbus/);

      const sum = await gdbus([
        'call',
        '--session',
        '--dest',
        SERVICE,
        '--object-path',
        ROOT,
        '--method',
        `${IFACE}.Add`,
        '20',
        '22'
      ]);
      assert.match(sum.stdout, /42/);

      const joined = await gdbus([
        'call',
        '--session',
        '--dest',
        SERVICE,
        '--object-path',
        ROOT,
        '--method',
        `${IFACE}.Concat`,
        "['a', 'b', 'c']"
      ]);
      assert.match(joined.stdout, /a\|b\|c/);
    });

    it('returns a{sv} that GDBus can read', async () => {
      const { stdout } = await gdbus([
        'call',
        '--session',
        '--dest',
        SERVICE,
        '--object-path',
        ROOT,
        '--method',
        `${IFACE}.Describe`
      ]);
      assert.match(stdout, /'name': <'e2e'>/);
      assert.match(stdout, /'count': <uint32 7>/);
    });

    it('answers method calls from sd-bus', async () => {
      const { stdout } = await busctl([
        'call',
        SERVICE,
        ROOT,
        IFACE,
        'Echo',
        's',
        'hello from busctl'
      ]);
      assert.match(stdout, /hello from busctl/);
    });

    it('answers method calls from python-dbus', async () => {
      const { stdout } = await run(
        'python3',
        [
          '-c',
          `
import dbus
bus = dbus.SessionBus()
obj = bus.get_object('${SERVICE}', '${ROOT}')
i = dbus.Interface(obj, '${IFACE}')
print('echo:', i.Echo('hello from python'))
print('add:', i.Add(dbus.UInt32(2), dbus.UInt32(3)))
p = dbus.Interface(obj, 'org.freedesktop.DBus.Properties')
print('greeting:', p.Get('${IFACE}', 'Greeting'))
print('hyphen:', p.Get('${IFACE}', 'my-prop'))
print('all:', sorted(dict(p.GetAll('${IFACE}')).keys()))
`
        ],
        { encoding: 'utf8' }
      );
      assert.match(stdout, /echo: hello from python/);
      assert.match(stdout, /add: 5/);
      assert.match(stdout, /greeting: hello/);
      assert.match(stdout, /hyphen: hyphens work/);
      assert.match(stdout, /'my-prop'/, 'GetAll includes the hyphenated one');
      console.log(
        stdout
          .split('\n')
          .map(l => `      ${l}`)
          .join('\n')
          .trimEnd()
      );
    });

    it('serves properties to sd-bus, including a write', async () => {
      const before = await busctl([
        'get-property',
        SERVICE,
        ROOT,
        IFACE,
        'Greeting'
      ]);
      assert.match(before.stdout, /s "hello"/);

      await busctl([
        'set-property',
        SERVICE,
        ROOT,
        IFACE,
        'Greeting',
        's',
        'written by sd-bus'
      ]);
      const after = await busctl([
        'get-property',
        SERVICE,
        ROOT,
        IFACE,
        'Greeting'
      ]);
      assert.match(after.stdout, /written by sd-bus/);
      assert.strictEqual(impl.Greeting, 'written by sd-bus');
    });

    it('refuses a write to a read-only property, in a way sd-bus reports', async () => {
      await assert.rejects(
        () =>
          busctl([
            'set-property',
            SERVICE,
            ROOT,
            IFACE,
            'Locked',
            'b',
            'false'
          ]),
        err => {
          assert.match(err.stderr || err.message, /read|denied|Property/i);
          return true;
        }
      );
      assert.strictEqual(impl.Locked, true, 'and the value did not move');
    });

    it('emits signals that GDBus receives', async () => {
      const monitor = execFile(
        'gdbus',
        ['monitor', '--session', '--dest', SERVICE],
        { encoding: 'utf8' }
      );
      const seen = [];
      monitor.stdout.on('data', chunk => seen.push(chunk));

      // gdbus takes a moment to install its match rule.
      await new Promise(resolve => setTimeout(resolve, 1200));
      for (let i = 0; i < 5; i++) {
        impl.emit('Pinged', `ping-${i}`);
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      const text = await eventually(
        () => (seen.join('').includes('Pinged') ? seen.join('') : null),
        { timeout: 8000, label: 'a Pinged signal at gdbus' }
      );
      monitor.kill();
      // gdbus prints the body as a tuple, so a one-argument signal comes out as
      // ('ping-0',) -- trailing comma and all.
      assert.match(text, /Pinged \('ping-\d',?\)/);
      console.log(
        `      ${text.split('\n').filter(l => l.includes('Pinged'))[0]}`
      );
    });

    it('reports an error the way a real client expects', async () => {
      await assert.rejects(
        () =>
          gdbus([
            'call',
            '--session',
            '--dest',
            SERVICE,
            '--object-path',
            ROOT,
            '--method',
            `${IFACE}.NoSuchMethod`
          ]),
        err => {
          assert.match(err.stderr, /UnknownMethod|No such method|Error/);
          return true;
        }
      );
    });

    it('is reachable through this library as well, for symmetry', async () => {
      const client = session();
      await client.getId();
      try {
        const iface = await new Promise((resolve, reject) =>
          client.getInterface(SERVICE, ROOT, IFACE, (err, value) =>
            err ? reject(err) : resolve(value)
          )
        );
        const echoed = await new Promise((resolve, reject) =>
          iface.Echo('round trip', (err, value) =>
            err ? reject(err) : resolve(value)
          )
        );
        assert.strictEqual(echoed, 'round trip');

        const object = await new Promise((resolve, reject) =>
          client.getObject(SERVICE, ROOT, (err, value) =>
            err ? reject(err) : resolve(value)
          )
        );
        assert.deepStrictEqual(object.nodes.sort(), ['Alpha', 'Beta']);
        assert.strictEqual(object.name, ROOT);
      } finally {
        close(client);
      }
    });
  }
);
