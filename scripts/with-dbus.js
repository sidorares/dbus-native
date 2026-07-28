#!/usr/bin/env node
//
// Run a command against a private d-bus session bus.
//
//   node scripts/with-dbus.js -- mocha test/integration
//
// Starts a throwaway dbus-daemon, exports DBUS_SESSION_BUS_ADDRESS for the
// child, then tears the daemon down when the child exits.

const { spawn } = require('child_process');
const { startSessionBus } = require('./dbus-daemon');

const argv = process.argv.slice(2);
const args = argv[0] === '--' ? argv.slice(1) : argv;

if (args.length === 0) {
  console.error('usage: node scripts/with-dbus.js -- <command> [args...]');
  process.exit(1);
}

startSessionBus().then(
  ({ address, stop }) => {
    const child = spawn(args[0], args.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address }
    });

    const forward = signal => () => child.kill(signal);
    process.on('SIGINT', forward('SIGINT'));
    process.on('SIGTERM', forward('SIGTERM'));

    child.on('error', err => {
      console.error(`failed to run ${args[0]}: ${err.message}`);
      stop();
      process.exit(1);
    });

    child.on('exit', (code, signal) => {
      stop();
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 1);
    });
  },
  err => {
    console.error(err.message);
    process.exit(1);
  }
);
