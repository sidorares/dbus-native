#!/usr/bin/env node

// dbus-native <command>
//
// Subcommands are the shape RELEASE_PLAN.md sets out; `types` is the first.

const fs = require('fs');
const { parseArgs } = require('util');
const path = require('path');
const { spawnSync } = require('child_process');
const dbus = require('../index');
const { parseIntrospection } = require('../lib/codegen/introspection');
const { emitTypes } = require('../lib/codegen/emit-types');
const cli = require('../lib/cli/call');

const USAGE = `Usage: dbus-native <command> [options]

Commands:
  call         call a method, the way dbus-send does
  get          read a property
  set          write a property
  list         list the names on the bus
  types        generate TypeScript declarations for a service
  introspect   print a service's raw introspection XML
  codemod      rewrite your source for a breaking change
  lint         report reads of value shapes that change in 0.14.0

Options for call/get/set/list:
  --dest <name>      bus name to talk to (call, get, set)
  --system           use the system bus (default: session)
  --address <addr>   connect to this address instead
  --json             print the reply as JSON
  --timeout <ms>     give up after this long (default 25000)
  --no-reply         send without waiting (call)
  --no-auto-start    fail rather than activating the service (call)
  --signature <sig>  give the signature explicitly, with --body
  --body <json>      arguments as a JSON array, with --signature
  --activatable      list what could be started, not what is running (list)
  --all              include unique names like :1.7 (list)

  Arguments to 'call' and 'set' are dbus-send's type:value form:
    string:hello  int32:-7  uint64:18446744073709551615  boolean:true
    byte:255  double:1.5  objpath:/com/example/Obj  signature:a{sv}
    array:string:a,b,c    dict:string:uint32:width,800
    variant:int32:42
  Use --signature/--body for anything that cannot express -- structs,
  deeper nesting, or a value containing a comma.

Options for types/introspect:
  --service <name>   bus name, e.g. org.freedesktop.NetworkManager
  --path <path>      object path, e.g. /org/freedesktop/NetworkManager
  --system           use the system bus (default: session)
  --xml <file>       read introspection XML from a file instead of the bus
  --out <file>       write to a file instead of stdout

Options for 'types':
  --target <t>       'plain' (default) or 'classic' for the classic value shapes
  --module <name>    module specifier to import types from
                     (default: dbus-native)
  --all              include the standard org.freedesktop.DBus.* interfaces
  --help             show this message

Options for 'codemod':
  dbus-native codemod <name> <path...>
  --dry              report what would change without writing
  Available: errors-to-error-objects  (0.7: errors became Error objects)

Options for 'lint':
  dbus-native lint <path...>
  --rule <codes>     only these, comma separated (DBUS_DEP0001..0003)
  --exit-zero        report findings but still exit 0
  Exits non-zero when there are findings, so it can gate CI.

Examples:
  dbus-native list
  dbus-native call --dest org.freedesktop.DBus \\
    /org/freedesktop/DBus org.freedesktop.DBus.ListNames

  dbus-native call --dest org.freedesktop.Notifications \\
    /org/freedesktop/Notifications org.freedesktop.Notifications.Notify \\
    string:hello uint32:0 string: string:Summary string:Body \\
    array:string: dict:string:string: int32:5000

  dbus-native get --system --dest org.freedesktop.UPower \\
    /org/freedesktop/UPower org.freedesktop.UPower DaemonVersion

  dbus-native codemod errors-to-error-objects src/
  dbus-native lint --rule DBUS_DEP0002 src/

  dbus-native types --system \\
    --service org.freedesktop.NetworkManager \\
    --path /org/freedesktop/NetworkManager \\
    --out src/generated/network-manager.d.ts

  dbus-native introspect --service org.freedesktop.DBus \\
    --path /org/freedesktop/DBus --out dbus.xml
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parse(argv) {
  try {
    return parseArgs({
      args: argv,
      options: {
        service: { type: 'string' },
        path: { type: 'string' },
        system: { type: 'boolean', default: false },
        xml: { type: 'string' },
        out: { type: 'string' },
        target: { type: 'string', default: 'plain' },
        module: { type: 'string', default: 'dbus-native' },
        all: { type: 'boolean', default: false },
        dry: { type: 'boolean', default: false },
        rule: { type: 'string' },
        'exit-zero': { type: 'boolean', default: false },
        dest: { type: 'string' },
        address: { type: 'string' },
        json: { type: 'boolean', default: false },
        timeout: { type: 'string' },
        'no-reply': { type: 'boolean', default: false },
        'no-auto-start': { type: 'boolean', default: false },
        signature: { type: 'string' },
        body: { type: 'string' },
        activatable: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false }
      },
      allowPositionals: true
    });
  } catch (err) {
    fail(`${err.message}\n\n${USAGE}`);
  }
}

// Read the XML from a file, or introspect a live service.
async function getXml(argv) {
  if (argv.xml) return fs.readFileSync(argv.xml, 'utf8');

  if (!argv.service || !argv.path) {
    fail(
      `Need --service and --path to introspect a live service, or --xml to read a file.\n\n${
        USAGE
      }`
    );
  }

  const bus = argv.system ? dbus.systemBus() : dbus.sessionBus();
  try {
    return await bus.invoke(
      {
        destination: argv.service,
        path: argv.path,
        interface: 'org.freedesktop.DBus.Introspectable',
        member: 'Introspect'
      },
      // Options are the second argument -- putting `timeout` in the message
      // makes it a stray field and the call waits forever.
      { timeout: 15000 }
    );
  } finally {
    bus.connection.end();
  }
}

const CODEMODS = ['errors-to-error-objects'];

/**
 * How to invoke jscodeshift.
 *
 * It is a devDependency here, not a runtime one -- a d-bus library has no
 * business putting a whole AST toolchain into every install for a one-off
 * migration. So we look for it in the consuming project first and fall back to
 * `npx`, which fetches it on demand and throws it away afterwards.
 */
function jscodeshiftCommand(args) {
  try {
    return {
      command: process.execPath,
      commandArgs: [require.resolve('jscodeshift/bin/jscodeshift.js'), ...args]
    };
  } catch {
    console.error('jscodeshift not installed locally; running it through npx');
    return {
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      commandArgs: ['--yes', 'jscodeshift', ...args]
    };
  }
}

/** Run a shipped codemod over the user's source. */
function runCodemod(name, paths, argv) {
  if (!CODEMODS.includes(name)) {
    fail(
      `Unknown codemod '${name}'. Available: ${CODEMODS.join(', ')}\n\n${USAGE}`
    );
  }
  if (paths.length === 0) fail(`Nothing to transform.\n\n${USAGE}`);

  const args = [
    '-t',
    require.resolve(`../lib/codemods/${name}`),
    '--parser',
    'babel'
  ];
  if (argv.dry) args.push('--dry', '--print');
  args.push(...paths);

  const { command, commandArgs } = jscodeshiftCommand(args);
  const { status, error } = spawnSync(command, commandArgs, {
    stdio: 'inherit'
  });
  if (error) fail(`could not run jscodeshift: ${error.message}`);
  process.exit(status === null ? 1 : status);
}

/**
 * Report reads of the value shapes that change in 0.14.0.
 *
 * Separate from `codemod` because these are the patterns a codemod *cannot*
 * safely rewrite: reading a variant is an index chain, and nothing in the
 * source says what the value is. Being honest about that matters -- the
 * tooling narrows the problem to a reviewed list of call sites, and there is
 * no complete codemod for 0.14.0.
 */
function runLint(paths, argv) {
  if (paths.length === 0) fail(`Nothing to lint.\n\n${USAGE}`);

  const lint = require('../lib/lint/deprecated-value-shapes');
  const args = ['-t', require.resolve('../lib/lint/deprecated-value-shapes')];
  args.push('--parser', 'babel', '--dry', '--run-in-band');
  if (argv.rule) args.push('--rule', argv.rule);
  args.push(...paths);

  const { command, commandArgs } = jscodeshiftCommand(args);
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) fail(`could not run jscodeshift: ${result.error.message}`);

  const findings = [];
  for (const line of (result.stdout || '').split('\n')) {
    const at = line.indexOf(lint.MARKER);
    if (at === -1) continue;
    try {
      findings.push(JSON.parse(line.slice(at + lint.MARKER.length)));
    } catch {
      // A partially flushed line is not worth failing the run over.
    }
  }

  if (findings.length === 0) {
    console.log('No deprecated value reads found.');
    return process.exit(0);
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || 0);
  for (const f of findings) {
    // Relative, so the report stays readable from a deep checkout, and a fixed
    // indent rather than one aligned to the path -- an absolute path pushes an
    // aligned hint off the side of the terminal.
    const where = `${path.relative(process.cwd(), f.file) || f.file}:${f.line}`;
    const maybe = f.confidence === 'possible' ? ' (possible)' : '';
    console.log(`${where}  ${f.code}  ${f.detail}${maybe}`);
    console.log(`    -> ${f.hint}`);
  }

  const byCode = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] || 0) + 1;
  const summary = Object.keys(byCode)
    .sort()
    .map(c => `${byCode[c]} ${c}`)
    .join(', ');
  console.log(
    `\n${findings.length} finding${findings.length === 1 ? '' : 's'} (${summary}). See docs/deprecations.md.`
  );
  // Non-zero so it can gate CI; --no-fail for a report-only run.
  process.exit(argv['exit-zero'] ? 0 : 1);
}

function write(argv, content) {
  if (argv.out) {
    fs.writeFileSync(argv.out, content);
    console.error(`wrote ${argv.out}`);
  } else {
    process.stdout.write(content);
  }
}

async function main() {
  const { values: argv, positionals } = parse(process.argv.slice(2));
  const command = positionals[0];

  if (argv.help || !command) {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }

  if (command === 'codemod') {
    return runCodemod(positionals[1], positionals.slice(2), argv);
  }

  if (command === 'lint') {
    return runLint(positionals.slice(1), argv);
  }

  // The bus-facing subcommands. Each returns text to print, or '' when there is
  // nothing to say -- a successful `set` should be silent, like any good tool.
  const busCommands = {
    call: cli.call,
    get: cli.get,
    set: cli.set,
    list: cli.list
  };
  if (busCommands[command]) {
    const output = await busCommands[command](positionals.slice(1), argv);
    if (output) console.log(output);
    return;
  }

  if (!['types', 'introspect'].includes(command)) {
    fail(`Unknown command '${command}'.\n\n${USAGE}`);
  }

  // 'next' was what 'plain' was called while these shapes were the future.
  // Still accepted, because it is written down in whatever script generated
  // the file you are regenerating.
  if (argv.target === 'next') argv.target = 'plain';
  if (!['plain', 'classic'].includes(argv.target)) {
    fail(`--target must be 'plain' or 'classic', got '${argv.target}'`);
  }

  const xml = await getXml(argv);

  if (command === 'introspect') return write(argv, xml);

  const description = await parseIntrospection(xml);
  if (description.interfaces.length === 0) {
    // Not an error: a path can be a pure container for child nodes.
    console.error(
      `warning: no interfaces at ${argv.path || argv.xml}${
        description.nodes.length
          ? `; child nodes: ${description.nodes.join(', ')}`
          : ''
      }`
    );
  }
  write(
    argv,
    emitTypes(description, {
      service: argv.service,
      path: argv.path,
      target: argv.target,
      moduleSpecifier: argv.module,
      skipStandard: !argv.all
    })
  );
}

main().catch(err => {
  // A d-bus error's name is the part worth acting on -- UnknownMethod and
  // AccessDenied want different responses, and the text alone does not say
  // which you got. dbus-send prints both, and so should this.
  if (err && err.dbusName) fail(`${err.dbusName}: ${err.message}`);
  fail(err && err.message ? err.message : String(err));
});
