#!/usr/bin/env node

// DEPRECATED. Superseded by `dbus-native types`, which emits TypeScript
// declarations and handles properties and signals. See DBUS_DEP0005 in
// docs/deprecations.md.
//
// Kept working for backwards compatibility: it is a published binary and
// removing it would break anyone who has it in a build script.

const fs = require('fs');
const { parseArgs } = require('util');
const xml2js = require('xml2js');
const dbus = require('../index');
const deprecate = require('../lib/deprecate');

const xml2jsOpts = { ...xml2js.defaults['0.1'], explicitArray: true };

const usage = `Usage: dbus2js [options]

  --service <name>   bus name to introspect, e.g. org.freedesktop.Notifications
  --path <path>      object path to introspect, e.g. /org/freedesktop/Notifications
  --bus <session|system>  which bus to connect to (default: session)
  --xml <file>       read introspection XML from a file instead of the bus
  --timeout <ms>     give up if the service does not answer (default: 15000)
  --dump             print the raw introspection XML and exit
  --server           do not generate a client proxy
  --help             show this message

DEPRECATED: use 'dbus-native types' instead.
`;

let argv;
try {
  ({ values: argv } = parseArgs({
    options: {
      service: { type: 'string' },
      path: { type: 'string' },
      bus: { type: 'string', default: 'session' },
      xml: { type: 'string' },
      timeout: { type: 'string', default: '15000' },
      dump: { type: 'boolean', default: false },
      server: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
  }));
} catch (err) {
  console.error(err.message);
  console.error(`\n${usage}`);
  process.exit(1);
}

if (argv.help) {
  console.log(usage);
  process.exit(0);
}

// Everything below goes to stderr, so stdout stays a clean stream of generated
// code that can be redirected straight to a file.
function announceDeprecation() {
  deprecate(
    'DBUS_DEP0005',
    "'dbus2js' is deprecated. Use 'dbus-native types', which emits TypeScript declarations and handles properties and signals."
  );

  // Build the equivalent command out of the arguments actually given, so
  // migrating is a copy and paste rather than a lookup.
  const equivalent = ['npx dbus-native types'];
  if (argv.bus === 'system') equivalent.push('--system');
  if (argv.service) equivalent.push(`--service ${argv.service}`);
  if (argv.path) equivalent.push(`--path ${argv.path}`);
  if (argv.xml) equivalent.push(`--xml ${argv.xml}`);
  equivalent.push('--out types.d.ts');

  console.error(
    [
      '',
      'dbus2js is deprecated and will be removed in a future major release.',
      '',
      'It emits untyped ES5, does not generate properties, and gives signals an',
      'over-broad match rule. `dbus-native types` emits TypeScript declarations',
      'covering methods, properties and signals.',
      '',
      `  ${equivalent.join(' \\\n    ')}`,
      '',
      'Then use the generated types with getInterface<T>():',
      '',
      "  import type { OrgExampleIface } from './types';",
      '  const iface = await bus',
      "    .getService('org.example')",
      "    .getInterface<OrgExampleIface>('/org/example', 'org.example.Iface');",
      '',
      'Docs: https://github.com/sidorares/dbus-native/blob/master/docs/deprecations.md#dbus_dep0005',
      ''
    ].join('\n')
  );
}

function die(err) {
  // stderr, not stdout: stdout carries the generated module.
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}

announceDeprecation();

if (!argv.xml && (!argv.service || !argv.path)) {
  console.error(
    'Need --service and --path to introspect a live service, or --xml to read a file.\n'
  );
  console.error(usage);
  process.exit(1);
}

const bus = argv.bus === 'system' ? dbus.systemBus() : dbus.sessionBus();

function getXML(callback) {
  if (argv.xml) {
    fs.readFile(argv.xml, 'ascii', callback);
  } else {
    bus.invoke(
      {
        destination: argv.service,
        path: argv.path,
        interface: 'org.freedesktop.DBus.Introspectable',
        member: 'Introspect'
      },
      // Options are the second argument. Without this, a service that is
      // present but not answering hangs the command forever.
      { timeout: Number(argv.timeout) || 0 },
      callback
    );
  }
}

// --dump used to fall through and introspect a second time, printing the XML
// and then the generated module into the same stream.
if (argv.dump) {
  getXML((err, xml) => {
    if (err) die(err);
    console.log(xml);
    bus.connection.end();
  });
} else if (!argv.server) {
  getXML((err, xml) => {
    if (err) die(err);

    const output = [];
    const parser = new xml2js.Parser(xml2jsOpts);
    parser.parseString(xml, (err, result) => {
      if (err) die(err);

      // A path can legitimately expose no interfaces and only child nodes.
      // Indexing straight into an absent key crashed here -- issue #148.
      const ifaces = (result && result['interface']) || [];
      if (ifaces.length === 0) {
        console.error(`warning: no interfaces at ${argv.path || argv.xml}`);
      }

      for (const iface of ifaces) {
        const ifaceName = iface['@'].name;

        output.push(`module.exports['${ifaceName}'] = function(bus) {`);
        output.push(
          '    this.addListener = this.on = function(signame, callback) {'
        );
        // Match on path and interface as well as member. Matching on member
        // alone asks the daemon for every signal of that name from every
        // service on the bus.
        output.push(
          `        var match = "type='signal',path='${argv.path}',interface='${ifaceName}',member='" + signame + "'";`
        );
        output.push('        bus.addMatch(match, function(err) {');
        output.push('            if (err) return console.error(String(err));');
        output.push('        });');
        output.push(
          `        var signalFullName = bus.mangle('${argv.path}', '${ifaceName}', signame);`
        );
        output.push(
          '        bus.signals.on(signalFullName, function(messageBody) {'
        );
        output.push('             callback.apply(null, messageBody);');
        output.push('        });');
        output.push('    };');

        for (const method of iface.method || []) {
          let signature = '';
          const methodName = method['@'].name;

          let decl = `    this.${methodName} = function(`;
          const params = [];
          for (const methodArg of method.arg || []) {
            const arg = methodArg['@'];
            if (arg.direction === 'in') {
              decl += `${arg.name}, `;
              params.push(arg.name);
              signature += arg.type;
            }
          }
          decl += 'callback) {';
          output.push(decl);
          output.push('        bus.invoke({');
          output.push(`            destination: '${argv.service}',`);
          output.push(`            path: '${argv.path}',`);
          output.push(`            interface: '${ifaceName}',`);
          output.push(`            member: '${methodName}',`);
          if (params.length > 0) {
            output.push(`            body: [${params.join(', ')}], `);
            output.push(`            signature: '${signature}',`);
          }
          output.push('        }, callback);');
          output.push('    };');
        }

        const skipped = (iface.property || []).map(p => p['@'].name);
        if (skipped.length) {
          // stderr, not stdout: these used to be printed into the middle of
          // the generated module, so redirecting the output produced a file
          // that was not valid JavaScript.
          console.error(
            `warning: ${ifaceName}: properties not generated (${skipped.join(', ')}); 'dbus-native types' emits them`
          );
        }
        output.push('}');
      }
      console.log(output.join('\n'));
      bus.connection.end();
    });
  });
} else {
  // --server generates nothing today; do not leave the connection open.
  bus.connection.end();
}
