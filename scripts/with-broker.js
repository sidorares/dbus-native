#!/usr/bin/env node
//
// Run a command against this library's own message bus.
//
//   node scripts/with-broker.js -- node --test test/integration/*.js
//
// The same contract as scripts/with-dbus.js -- exports
// DBUS_SESSION_BUS_ADDRESS for the child and tears the bus down afterwards --
// except that the bus is lib/broker.js rather than dbus-daemon, so this needs
// nothing installed.
//
// Running the integration suite both ways is the point: the tests do not know
// which bus they are talking to, so anywhere the two disagree shows up as a
// test that passes against one and fails against the other.

const { spawn } = require('child_process');
const dbus = require('../index');

const argv = process.argv.slice(2);
const args = argv[0] === '--' ? argv.slice(1) : argv;

if (args.length === 0) {
  console.error('usage: node scripts/with-broker.js -- <command> [args...]');
  process.exit(1);
}

const broker = dbus.createBroker();

broker.on('error', err => {
  console.error(`broker: ${err.message}`);
});
// A fault while serving one client is worth seeing on stderr -- it is the
// difference between "the test failed" and "the bus is broken".
broker.on('clientError', err => {
  if (!/ECONNRESET|EPIPE|closed/i.test(err.message)) {
    console.error(`broker: ${err.message}`);
  }
});

broker.listen((err, address) => {
  if (err) {
    console.error(`broker: ${err.message}`);
    process.exit(1);
  }

  const child = spawn(args[0], args.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address }
  });

  const forward = signal => () => child.kill(signal);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));

  child.on('error', spawnError => {
    console.error(`failed to run ${args[0]}: ${spawnError.message}`);
    broker.close(() => process.exit(1));
  });

  child.on('exit', (code, signal) => {
    broker.close(() => {
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 1);
    });
  });
});
