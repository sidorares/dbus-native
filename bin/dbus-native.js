#!/usr/bin/env node

// dbus-native <command>
//
// Subcommands are the shape RELEASE_PLAN.md sets out; `types` is the first.

const fs = require('fs');
const { parseArgs } = require('util');
const { spawnSync } = require('child_process');
const dbus = require('../index');
const { parseIntrospection } = require('../lib/codegen/introspection');
const { emitTypes } = require('../lib/codegen/emit-types');

const USAGE = `Usage: dbus-native <command> [options]

Commands:
  types        generate TypeScript declarations for a service
  introspect   print a service's raw introspection XML
  codemod      rewrite your source for a breaking change

Options for both:
  --service <name>   bus name, e.g. org.freedesktop.NetworkManager
  --path <path>      object path, e.g. /org/freedesktop/NetworkManager
  --system           use the system bus (default: session)
  --xml <file>       read introspection XML from a file instead of the bus
  --out <file>       write to a file instead of stdout

Options for 'types':
  --target <t>       'classic' (default) or 'next' for the 2.0 value shapes
  --module <name>    module specifier to import types from
                     (default: dbus-native)
  --all              include the standard org.freedesktop.DBus.* interfaces
  --help             show this message

Options for 'codemod':
  dbus-native codemod <name> <path...>
  --dry              report what would change without writing
  Available: errors-to-error-objects  (0.7: errors became Error objects)

Examples:
  dbus-native codemod errors-to-error-objects src/

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
        target: { type: 'string', default: 'classic' },
        module: { type: 'string', default: 'dbus-native' },
        all: { type: 'boolean', default: false },
        dry: { type: 'boolean', default: false },
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
 * Run a shipped codemod over the user's source.
 *
 * jscodeshift is a devDependency here, not a runtime one -- a d-bus library
 * has no business putting a whole AST toolchain into every install for a
 * one-off migration. So we look for it in the consuming project first and fall
 * back to `npx`, which fetches it on demand and throws it away afterwards.
 */
function runCodemod(name, paths, argv) {
  if (!CODEMODS.includes(name)) {
    fail(
      `Unknown codemod '${name}'. Available: ${CODEMODS.join(', ')}\n\n${USAGE}`
    );
  }
  if (paths.length === 0) fail(`Nothing to transform.\n\n${USAGE}`);

  const transform = require.resolve(`../lib/codemods/${name}`);
  const args = ['-t', transform, '--parser', 'babel'];
  if (argv.dry) args.push('--dry', '--print');
  args.push(...paths);

  let command, commandArgs;
  try {
    // jscodeshift's own bin, if the project already has it.
    command = process.execPath;
    commandArgs = [require.resolve('jscodeshift/bin/jscodeshift.js'), ...args];
  } catch {
    command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    commandArgs = ['--yes', 'jscodeshift', ...args];
    console.error('jscodeshift not installed locally; running it through npx');
  }

  const { status, error } = spawnSync(command, commandArgs, {
    stdio: 'inherit'
  });
  if (error) fail(`could not run jscodeshift: ${error.message}`);
  process.exit(status === null ? 1 : status);
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

  if (!['types', 'introspect'].includes(command)) {
    fail(`Unknown command '${command}'.\n\n${USAGE}`);
  }

  if (!['classic', 'next'].includes(argv.target)) {
    fail(`--target must be 'classic' or 'next', got '${argv.target}'`);
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
  fail(err && err.message ? err.message : String(err));
});
