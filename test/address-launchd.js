// The launchd: transport, which is how macOS advertises its session bus.
//
// https://dbus.freedesktop.org/doc/dbus-specification.html#transports-launchd
//
// `launchctl` is stubbed by putting a script earlier on PATH rather than by
// calling `launchctl setenv`, which would change the user's real login session
// and outlive the test run.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const dbus = require('../index');

let tmp, socketPath, server;
const realPath = process.env.PATH;
const realAddress = process.env.DBUS_SESSION_BUS_ADDRESS;

/** Put a fake `launchctl getenv` on PATH, answering from `vars`. */
function stubLaunchctl(vars) {
  const script = `#!/bin/sh
# getenv <name>: print the value, or nothing at all -- which is what the real
# launchctl does for a variable that is not set, exit code 0 either way.
if [ "$1" = "getenv" ]; then
  case "$2" in
${Object.entries(vars)
  .map(([name, value]) => `    ${name}) echo "${value}" ;;`)
  .join('\n')}
    *) ;;
  esac
fi
exit 0
`;
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'launchctl'), script, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${realPath}`;
}

/** PATH with no launchctl at all, as on Linux. */
function noLaunchctl() {
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  process.env.PATH = empty;
}

describe('launchd: addresses', () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-launchd-'));
    // A short path: a unix socket path is limited to ~104 bytes on macOS.
    socketPath = path.join(tmp, 's');
    server = net.createServer(conn => conn.end());
    await new Promise(resolve => server.listen(socketPath, resolve));
  });

  after(() => {
    process.env.PATH = realPath;
    if (realAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = realAddress;
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.PATH = realPath;
    delete process.env.DBUS_LAUNCHD_TEST_SOCKET;
  });

  const connect = busAddress =>
    new Promise((resolve, reject) => {
      let stream;
      try {
        stream = dbus.createConnection({ busAddress }).stream;
      } catch (e) {
        return reject(e);
      }
      stream.once('connect', () => {
        stream.destroy();
        resolve();
      });
      stream.once('error', reject);
    });

  it('resolves the socket through launchctl getenv', async () => {
    stubLaunchctl({ DBUS_LAUNCHD_TEST_SOCKET: socketPath });
    await connect('launchd:env=DBUS_LAUNCHD_TEST_SOCKET');
  });

  it('falls back to our own environment when launchctl has no answer', async () => {
    stubLaunchctl({});
    process.env.DBUS_LAUNCHD_TEST_SOCKET = socketPath;
    await connect('launchd:env=DBUS_LAUNCHD_TEST_SOCKET');
  });

  it('falls back to our own environment when launchctl is absent', async () => {
    noLaunchctl();
    process.env.DBUS_LAUNCHD_TEST_SOCKET = socketPath;
    await connect('launchd:env=DBUS_LAUNCHD_TEST_SOCKET');
  });

  it('prefers launchctl over our environment, as the spec intends', async () => {
    stubLaunchctl({ DBUS_LAUNCHD_TEST_SOCKET: socketPath });
    process.env.DBUS_LAUNCHD_TEST_SOCKET = path.join(tmp, 'wrong');
    await connect('launchd:env=DBUS_LAUNCHD_TEST_SOCKET');
  });

  it('says what is missing when the variable is set nowhere', async () => {
    stubLaunchctl({});
    await assert.rejects(
      () => connect('launchd:env=DBUS_LAUNCHD_TEST_SOCKET'),
      {
        message:
          /DBUS_LAUNCHD_TEST_SOCKET, which is set neither in the launchd environment nor in this process/
      }
    );
  });

  it('rejects an address with no env parameter', async () => {
    await assert.rejects(() => connect('launchd:'), {
      message: /not enough parameters for 'launchd' connection/
    });
  });

  it('is tried after an earlier address in the list fails', async () => {
    stubLaunchctl({ DBUS_LAUNCHD_TEST_SOCKET: socketPath });
    await connect('unix:;launchd:env=DBUS_LAUNCHD_TEST_SOCKET');
  });
});

describe('the default session bus address', () => {
  it('falls back to launchd on macOS, and nothing elsewhere', () => {
    const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    try {
      assert.throws(
        () => dbus.createConnection({}),
        process.platform === 'darwin'
          ? // Reaching the launchd lookup at all is the point: on a Mac with
            // no bus running this is as far as it can get.
            /DBUS_LAUNCHD_SESSION_BUS_SOCKET|ENOENT|connect/
          : /unknown bus address/
      );
    } finally {
      if (saved === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = saved;
    }
  });
});
