#!/usr/bin/env node

const fs = require('fs');
const { parseArgs } = require('util');
const xml2js = require('xml2js');
const dbus = require('../index');

const xml2jsOpts = { ...xml2js.defaults['0.1'], explicitArray: true };

const usage = `Usage: dbus2js [options]

  --service <name>   bus name to introspect, e.g. org.freedesktop.Notifications
  --path <path>      object path to introspect, e.g. /org/freedesktop/Notifications
  --bus <session|system>  which bus to connect to (default: session)
  --xml <file>       read introspection XML from a file instead of the bus
  --dump             print the raw introspection XML
  --server           do not generate a client proxy
  --help             show this message
`;

let argv;
try {
  ({ values: argv } = parseArgs({
    options: {
      service: { type: 'string' },
      path: { type: 'string' },
      bus: { type: 'string', default: 'session' },
      xml: { type: 'string' },
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

console.error(
  "note: 'dbus2js' generates untyped ES5. 'dbus-native types' generates " +
    'TypeScript declarations and handles properties and signals.'
);

function die(err) {
  console.log(err);
  process.exit(-1);
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
      callback
    );
  }
}

if (argv.dump) {
  getXML((err, xml) => {
    if (err) die(err);
    console.log(xml);
    bus.connection.end();
  });
}

if (!argv.server) {
  getXML((err, xml) => {
    if (err) die(err);

    const output = [];

    const parser = new xml2js.Parser(xml2jsOpts);
    parser.parseString(xml, (err, result) => {
      if (err) die(err);

      const ifaces = result['interface'];
      for (const iface of ifaces) {
        const ifaceName = iface['@'].name;

        output.push(`module.exports['${ifaceName}'] = function(bus) {`);
        output.push(
          '    this.addListener = this.on = function(signame, callback) {'
        );
        //TODO: add path and interface to path
        output.push(
          "        bus.addMatch('type=\\'signal\\',member=\\'' + signame + '\\'', function(err, result) {"
        );
        output.push('            if (err) throw new Error(err);');
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
        for (const property of iface.property || []) {
          // stderr, not stdout: this used to be printed into the middle of the
          // generated module, so piping the output to a file produced a file
          // that was not valid JavaScript.
          console.error(
            `  note: property not generated: ${property['@'].name}`
          );
        }
        output.push('}');
      }
      console.log(output.join('\n'));
      bus.connection.end();
    });
  });
}
