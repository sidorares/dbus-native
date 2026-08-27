// Bus addresses and the transports behind them.
// https://dbus.freedesktop.org/doc/dbus-specification.html#addresses

const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { Duplex } = require('stream');

const bunTransport = require('./transport-bun');

// A d-bus address is `family:key=value,key=value`, and DBUS_SESSION_BUS_ADDRESS
// may hold several of them separated by `;`.
function parseAddressParams(address) {
  const [family, paramString = ''] = address.split(':');
  const params = {};
  for (const pair of paramString.split(',')) {
    if (!pair) continue;
    const [key, value] = pair.split('=');
    params[key] = value;
  }
  return { family: family.toLowerCase(), params };
}

/**
 * The socket path behind a `launchd:env=VAR` address.
 *
 * macOS keeps the session bus socket in the *launchd* environment, which is
 * not necessarily ours -- a process that was not started from a shell holding
 * the variable still needs to find it. So the spec names a variable to look up
 * with `launchctl getenv` rather than a path.
 * https://dbus.freedesktop.org/doc/dbus-specification.html#transports-launchd
 */
function launchdSocketPath(varName) {
  // spawnSync blocks, which is acceptable exactly once during connection setup
  // and before any I/O has happened. The alternative is making createStream()
  // async, which would make createConnection() -- and so sessionBus() -- async
  // for every caller on every platform, to fix one transport on one of them.
  //
  // No shell is involved (args are passed as an array), so the variable name
  // out of the address string cannot turn into a command.
  const result = spawnSync('launchctl', ['getenv', varName], {
    encoding: 'utf8'
  });
  const fromLaunchd =
    !result.error && result.status === 0 ? result.stdout.trim() : '';

  // `launchctl getenv` exits 0 with no output for a variable that is not set,
  // and off macOS it is not there at all. Either way our own environment is
  // worth a look before giving up -- it is where the variable usually is when
  // the process came from a shell.
  return fromLaunchd || process.env[varName] || '';
}

/**
 * The child process behind a `unixexec:` address, and the arguments it gets.
 *
 * The keys are `argv0` and `argv1`, `argv2`, ... -- not `arg0`/`arg1`, which is
 * what this read until 0.14.0 and meant a spec-conformant address had every
 * argument silently dropped. `argv0` is the *program name* (execlp's second
 * argument), not the first real argument, so it does not belong in the list.
 * https://dbus.freedesktop.org/doc/dbus-specification.html#transports-exec
 */
function unixexecArgs(params) {
  const args = [];
  // "If a specific argvX is not specified no further argvY for Y > X are taken
  // into account" -- so a gap ends the list rather than being skipped over.
  for (let n = 1; params[`argv${n}`] !== undefined; n++) {
    args.push(params[`argv${n}`]);
  }
  return args;
}

/**
 * A unix-socket connection, carrying file descriptors where it can.
 *
 * `target` is `{ path }` or `{ abstract }`. Under Bun the connection is one
 * this package owns and drives with sendmsg/recvmsg, so it can carry a
 * descriptor -- see lib/transport-bun.js, and docs/api.md "File descriptors"
 * for what that turns on. Anywhere else, and whenever that fails for any
 * reason, this is the ordinary socket it has always been.
 *
 * `opts.fdTransport: false` opts out, which is the switch to reach for if the
 * reader thread is unwelcome or something about it misbehaves.
 */
function unixConnection(target, opts) {
  if (!opts || opts.fdTransport !== false) {
    const stream = bunTransport.connect(target);
    if (stream) return stream;
  }
  if (target.abstract !== undefined) {
    // Node supports Linux abstract sockets natively since v20.8.0 by
    // prefixing the path with a NUL byte - no native addon required.
    return net.createConnection(`\0${target.abstract}`);
  }
  return net.createConnection(target.path);
}

function connectToAddress(address, opts) {
  const { family, params } = parseAddressParams(address);

  switch (family) {
    case 'tcp':
      return net.createConnection(params.port, params.host || 'localhost');
    case 'unix':
      if (params.socket) return unixConnection({ path: params.socket }, opts);
      if (params.abstract) {
        return unixConnection({ abstract: params.abstract }, opts);
      }
      if (params.path) return unixConnection({ path: params.path }, opts);
      throw new Error(
        "not enough parameters for 'unix' connection - you need to specify 'socket' or 'abstract' or 'path' parameter"
      );
    case 'launchd': {
      if (!params.env) {
        throw new Error(
          "not enough parameters for 'launchd' connection - you need to specify the 'env' parameter"
        );
      }
      const path = launchdSocketPath(params.env);
      if (!path) {
        throw new Error(
          `launchd address names ${params.env}, which is set neither in the launchd environment nor in this process. Is dbus running? (brew services start dbus)`
        );
      }
      return unixConnection({ path }, opts);
    }
    case 'unixexec': {
      if (!params.path) {
        throw new Error(
          "not enough parameters for 'unixexec' connection - you need to specify the 'path' parameter"
        );
      }
      // Node defaults argv[0] to the command when the option is left out,
      // which is what the spec asks for when argv0 is absent.
      const child = spawn(params.path, unixexecArgs(params), {
        argv0: params.argv0
      });
      return Duplex.from({ writable: child.stdin, readable: child.stdout });
    }
    default:
      throw new Error(`unknown address type:${family}`);
  }
}

module.exports = {
  parseAddressParams,
  launchdSocketPath,
  unixexecArgs,
  unixConnection,
  connectToAddress
};
