// Shared helper for spawning a private, throwaway d-bus session daemon.
//
// It writes a minimal permissive bus config to a temp dir and starts
// `dbus-daemon` against it, so nothing touches (or depends on) the user's real
// session bus. Works the same on macOS (`brew install dbus`) and Linux.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// `unix:dir=` (rather than `tmpdir=`) forces a real socket file on Linux too,
// which keeps the address shape identical across platforms.
const busConfig = dir => `<!DOCTYPE busconfig PUBLIC
 "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=${dir}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`;

function findDaemon() {
  const which = spawnSync('which', ['dbus-daemon'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  throw new Error(
    'dbus-daemon not found on PATH.\n' +
      '  macOS:  brew install dbus\n' +
      '  Debian: apt-get install dbus\n' +
      '  Fedora: dnf install dbus-daemon'
  );
}

// Starts a daemon and resolves once it has printed its bus address.
// Resolves to { address, stop() }.
function startSessionBus() {
  const daemon = findDaemon();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-native-'));
  const configFile = path.join(dir, 'session.conf');
  fs.writeFileSync(configFile, busConfig(dir));

  const child = spawn(
    daemon,
    [`--config-file=${configFile}`, '--print-address', '--nofork'],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );

  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort - the temp dir will be reaped by the OS anyway
    }
  };

  const stop = () => {
    if (!child.killed) child.kill('SIGTERM');
    cleanup();
  };

  return new Promise((resolve, reject) => {
    let out = '';
    const onData = chunk => {
      out += chunk;
      const newline = out.indexOf('\n');
      if (newline === -1) return;
      child.stdout.off('data', onData);
      resolve({ address: out.slice(0, newline).trim(), stop, child });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.once('error', err => {
      cleanup();
      reject(err);
    });
    child.once('exit', code => {
      cleanup();
      reject(new Error(`dbus-daemon exited early with code ${code}`));
    });
  });
}

module.exports = { startSessionBus };
