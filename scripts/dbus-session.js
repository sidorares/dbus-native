#!/usr/bin/env node
//
// Start a private d-bus session bus and keep it running in the foreground.
//
//   npm run dbus:session
//
// Prints the export line you can paste into another shell to point examples and
// scripts at this bus. Ctrl-C shuts it down and removes its socket.

const { startSessionBus } = require('./dbus-daemon');

startSessionBus().then(
  ({ address, stop, child }) => {
    console.log(`DBUS_SESSION_BUS_ADDRESS=${address}`);
    console.log('');
    console.log('Point another shell at this bus with:');
    console.log(`  export DBUS_SESSION_BUS_ADDRESS='${address}'`);
    console.log('');
    console.log('Press Ctrl-C to stop.');

    const shutdown = () => {
      stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    child.on('exit', code => process.exit(code ?? 0));
  },
  err => {
    console.error(err.message);
    process.exit(1);
  }
);
