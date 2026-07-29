// A real connection to a real daemon, reached through a launchd: address.
//
// test/address-launchd.js checks the lookup against a bare socket; this checks
// that a bus reached that way actually completes the SASL handshake and serves
// calls, which is the thing #95 asked for.
//
// The daemon is the one the integration suite already runs -- its address is
// re-expressed as launchd:env=... with `launchctl` stubbed on PATH, so nothing
// touches the user's real login session.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dbus = require('../../index');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

// The suite's daemon listens on a unix socket; a tcp: address has no path to
// hand to launchd, so there would be nothing to test.
const socketOf = address => {
  const match = /^unix:(?:path|socket)=([^,;]+)/.exec(address || '');
  return match && match[1];
};

const SOCKET = socketOf(process.env.DBUS_SESSION_BUS_ADDRESS);
const SKIP = NO_BUS || (!SOCKET && 'session bus is not on a unix socket');

describe(
  'integration: launchd transport',
  { timeout: 10000, skip: SKIP },
  () => {
    let tmp;
    const realPath = process.env.PATH;

    before(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-launchd-int-'));
      const bin = path.join(tmp, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(
        path.join(bin, 'launchctl'),
        `#!/bin/sh
[ "$1" = "getenv" ] && [ "$2" = "DBUS_LAUNCHD_TEST_BUS" ] && echo "${SOCKET}"
exit 0
`,
        { mode: 0o755 }
      );
      process.env.PATH = `${bin}${path.delimiter}${realPath}`;
    });

    after(() => {
      process.env.PATH = realPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('completes the handshake and serves calls', async () => {
      const bus = dbus.sessionBus({
        busAddress: 'launchd:env=DBUS_LAUNCHD_TEST_BUS'
      });
      try {
        const id = await bus.getId();
        assert.match(id, /^[0-9a-f]+$/);

        const names = await bus.listNames();
        assert.ok(
          names.includes('org.freedesktop.DBus'),
          'the daemon is on the bus we reached'
        );
      } finally {
        bus.connection.end();
      }
    });

    it('gets a unique name, so Hello went through', async () => {
      const bus = dbus.sessionBus({
        busAddress: 'launchd:env=DBUS_LAUNCHD_TEST_BUS'
      });
      try {
        await bus.getId();
        assert.match(bus.name, /^:\d+\.\d+$/);
      } finally {
        bus.connection.end();
      }
    });
  }
);
