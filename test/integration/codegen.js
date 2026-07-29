// Generate declarations from a live service and compile them.
//
// A codegen test that only inspects strings proves very little. This exports a
// real interface, generates a .d.ts from what the daemon reports, and runs tsc
// over a file that uses it -- so the generator is checked end to end against
// both the wire format and the emitted types.
//
// Everything spawned here is awaited rather than run synchronously. The
// service being introspected lives in *this* process, so execFileSync would
// block the event loop that has to answer the introspection call and the two
// would wait on each other until the call timed out.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { EventEmitter } = require('events');
const dbus = require('../../index');

// node:test skips a whole suite from its options, evaluated at load time.
const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const run = promisify(execFile);

const SERVICE = 'com.github.sidorares.dbusnative.Codegen';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/Codegen';
const IFACE = 'com.github.sidorares.dbusnative.CodegenIface';

const REPO = path.join(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin/dbus-native.js');

const ifaceDesc = {
  name: IFACE,
  methods: {
    Echo: ['s', 's', ['input'], ['output']],
    Add: ['ii', 'i', ['a', 'b'], ['sum']],
    Pair: ['', 'si', [], ['name', 'count']],
    Blob: ['ay', 'ay', ['data'], ['out']],
    Nothing: ['', '', [], []]
  },
  signals: { Pinged: ['si', 'who', 'times'] },
  properties: { Greeting: 's', Count: 'u' }
};

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'node16',
    moduleResolution: 'node16',
    lib: ['ES2022', 'DOM'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    typeRoots: [path.join(REPO, 'node_modules/@types')]
  },
  include: ['*.ts']
};

describe(
  'integration: codegen against a live service',
  { timeout: 60000, skip: NO_BUS },
  () => {
    let serviceBus;
    let tmp;

    before(async () => {
      serviceBus = dbus.sessionBus();
      const impl = Object.assign(Object.create(EventEmitter.prototype), {
        Greeting: 'hello',
        Count: 1,
        Echo: s => s,
        Add: (a, b) => a + b,
        Pair: () => ['x', 1],
        Blob: b => b,
        Nothing: () => null
      });
      EventEmitter.call(impl);
      await serviceBus.getId();
      await serviceBus.requestName(SERVICE, 0);
      serviceBus.exportInterface(impl, OBJECT_PATH, ifaceDesc);

      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-codegen-'));
      fs.writeFileSync(
        path.join(tmp, 'tsconfig.json'),
        JSON.stringify(TSCONFIG)
      );
    });

    after(() => {
      if (serviceBus) serviceBus.connection.end();
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    async function generate(extra = []) {
      const { stdout } = await run(
        process.execPath,
        [
          CLI,
          'types',
          '--service',
          SERVICE,
          '--path',
          OBJECT_PATH,
          '--module',
          REPO,
          ...extra
        ],
        { encoding: 'utf8', env: process.env }
      );
      return stdout;
    }

    const typeCheck = () =>
      run(path.join(REPO, 'node_modules/.bin/tsc'), [
        '-p',
        path.join(tmp, 'tsconfig.json')
      ]);

    it('generates declarations from a live introspection', async () => {
      const out = await generate();
      assert.match(
        out,
        /export interface ComGithubSidoraresDbusnativeCodegenIface/
      );
      assert.match(out, /Echo\(input: string\): DBusPromise<string>;/);
      assert.match(out, /Add\(a: number, b: number\): DBusPromise<number>;/);
      // several out arguments become a tuple
      assert.match(out, /Pair\(\): DBusPromise<\[string, number\]>;/);
      // ay is a Buffer, not number[]
      assert.match(out, /Blob\(data: Buffer\): DBusPromise<Buffer>;/);
      assert.match(out, /Nothing\(\): DBusPromise<void>;/);
      // properties and signals
      assert.match(out, /Greeting\(\): DBusPromise<string>;/);
      assert.match(
        out,
        /on\(event: 'Pinged', listener: \(who: string, times: number\) => void\): this;/
      );
      assert.match(
        out,
        /once\(event: 'Pinged', listener: \(who: string, times: number\) => void\): this;/
      );
    });

    it('omits the standard interfaces by default, includes them with --all', async () => {
      assert.doesNotMatch(await generate(), /OrgFreedesktopDBusPeer/);
      assert.match(await generate(['--all']), /OrgFreedesktopDBusPeer/);
    });

    it('the generated declarations compile and are usable', async () => {
      fs.writeFileSync(path.join(tmp, 'service.d.ts'), await generate());
      fs.writeFileSync(
        path.join(tmp, 'use.ts'),
        `
import type { ComGithubSidoraresDbusnativeCodegenIface as Iface } from './service';
import dbus = require(${JSON.stringify(REPO)});

async function main() {
  const bus = dbus.sessionBus();
  const iface = await bus
    .getService(${JSON.stringify(SERVICE)})
    .getInterface<Iface>(${JSON.stringify(OBJECT_PATH)}, ${JSON.stringify(IFACE)});

  const echoed: string = await iface.Echo('hi');
  const sum: number = await iface.Add(1, 2);
  const pair: [string, number] = await iface.Pair();
  const blob: Buffer = await iface.Blob(Buffer.from([1]));
  const greeting: string = await iface.Greeting();
  // the typed overloads return \`this\`, so subscriptions chain
  iface
    .on('Pinged', (who: string, times: number) => void [who, times])
    .once('Pinged', (who: string, times: number) => void [who, times]);
  const pinged: string[] = iface.$signals.Pinged;
  await iface.$subscribe('Pinged', () => {});
  void [echoed, sum, pair, blob, greeting, pinged];
}
void main;
`
      );
      await typeCheck();
    });

    it('rejects a wrong type against the generated surface', async () => {
      fs.writeFileSync(path.join(tmp, 'service.d.ts'), await generate());
      fs.writeFileSync(
        path.join(tmp, 'use.ts'),
        `
import type { ComGithubSidoraresDbusnativeCodegenIface as Iface } from './service';
declare const iface: Iface;
// Echo returns a string, not a number
const wrong: number = null as unknown as Awaited<ReturnType<Iface['Echo']>>;
void wrong;
`
      );
      let failed = false;
      try {
        await typeCheck();
      } catch (err) {
        failed = true;
        assert.match(err.stdout || '', /is not assignable to type 'number'/);
      }
      assert.ok(failed, 'tsc should have rejected the wrong return type');
    });

    it('introspect prints the raw xml', async () => {
      const { stdout } = await run(
        process.execPath,
        [CLI, 'introspect', '--service', SERVICE, '--path', OBJECT_PATH],
        { encoding: 'utf8', env: process.env }
      );
      assert.match(stdout, /<interface name="com\.github\.sidorares/);
    });
  }
);
