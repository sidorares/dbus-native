const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const constants = require('./constants');
const readLine = require('./readline');

function sha1(input) {
  const shasum = crypto.createHash('sha1');
  shasum.update(input);
  return shasum.digest('hex');
}

function getUserHome() {
  // os.homedir() already prefers $HOME / %USERPROFILE% and falls back to the
  // platform's user database, so it covers what the old regex meant to do.
  return os.homedir();
}

function hasGetuid() {
  return typeof process.getuid === 'function';
}

function getCookie(context, id, cb) {
  // http://dbus.freedesktop.org/doc/dbus-specification.html#auth-mechanisms-sha
  const dirname = path.join(getUserHome(), '.dbus-keyrings');
  // > There is a default context, "org_freedesktop_general" that's used by servers that do not specify otherwise.
  if (context.length === 0) context = 'org_freedesktop_general';

  const filename = path.join(dirname, context);
  // check it's not writable by others and readable by user
  fs.stat(dirname, (err, stat) => {
    if (err) return cb(err);
    if (stat.mode & 0o22)
      return cb(
        new Error(
          'User keyrings directory is writeable by other users. Aborting authentication'
        )
      );
    if (hasGetuid() && stat.uid !== process.getuid())
      return cb(
        new Error(
          'Keyrings directory is not owned by the current user. Aborting authentication!'
        )
      );
    fs.readFile(filename, 'ascii', (err, keyrings) => {
      if (err) return cb(err);
      const lines = keyrings.split('\n');
      for (let l = 0; l < lines.length; ++l) {
        const data = lines[l].split(' ');
        if (id === data[0]) return cb(null, data[2]);
      }
      return cb(new Error('cookie not found'));
    });
  });
}

function hexlify(input) {
  return Buffer.from(input.toString(), 'ascii').toString('hex');
}

// The handshake is a conversation, so between any two of its writes the
// caller may have closed the connection -- a short-lived tool that calls
// `connection.end()` as soon as it has what it wants does exactly that. The
// write then fails with ERR_STREAM_WRITE_AFTER_END, which surfaces as an
// unhandled 'error' on the connection and takes the process down. That is
// issue #20, and it is a race, so it shows up intermittently.
//
// Writing to a stream the caller has closed is not an error worth reporting:
// they asked for the connection to go away, and it has. Abandon the handshake
// quietly instead.
function writable(stream) {
  return (
    !stream.writableEnded && !stream.destroyed && stream.writable !== false
  );
}

// Returns false when the stream went away, so callers can stop.
function send(stream, data) {
  if (!writable(stream)) return false;
  stream.write(data);
  return true;
}

module.exports = function auth(stream, opts, cb) {
  const authMethods = opts.authMethods || constants.defaultAuthMethods;
  if (!send(stream, '\0')) return;
  // slice() so we don't accidentally mutate the caller's array
  tryAuth(stream, authMethods.slice(), cb);
};

function tryAuth(stream, methods, cb) {
  if (methods.length === 0) {
    return cb(new Error('No authentication methods left to try'));
  }

  const authMethod = methods.shift();
  const uid = hasGetuid() ? process.getuid() : 0;
  const id = hexlify(uid);

  function beginOrNextAuth() {
    readLine(stream, line => {
      const ok = line.toString('ascii').match(/^([A-Za-z]+) (.*)/);
      if (ok && ok[1] === 'OK') {
        if (!send(stream, 'BEGIN\r\n')) return;
        return cb(null, ok[2]); // ok[2] = guid. Do we need it?
      }
      // The server rejected this mechanism (typically `REJECTED <methods>`);
      // fall through to the next one we know about.
      if (methods.length > 0) {
        return tryAuth(stream, methods, cb);
      }
      return cb(
        new Error(
          `No authentication methods left to try. Last server response: ${line
            .toString('ascii')
            .trim()}`
        )
      );
    });
  }

  switch (authMethod) {
    case 'EXTERNAL':
      if (!send(stream, `AUTH ${authMethod} ${id}\r\n`)) return;
      beginOrNextAuth();
      break;
    case 'DBUS_COOKIE_SHA1':
      if (!send(stream, `AUTH ${authMethod} ${id}\r\n`)) return;
      readLine(stream, line => {
        const data = Buffer.from(line.toString().split(' ')[1].trim(), 'hex')
          .toString()
          .split(' ');
        const cookieContext = data[0];
        const cookieId = data[1];
        const serverChallenge = data[2];
        // any random 16 bytes should work, hex-encoded to keep it simple
        const clientChallenge = crypto.randomBytes(16).toString('hex');
        getCookie(cookieContext, cookieId, (err, cookie) => {
          if (err) return cb(err);
          const response = sha1(
            [serverChallenge, clientChallenge, cookie].join(':')
          );
          // The two fields are separated by a space before hex-encoding:
          //
          // > the client ... concatenates ... the client's challenge string, a
          // > space character, and the SHA-1 hex digest, hex-encodes the
          // > result and sends it back to the server.
          //
          // Without the space the server sees one 72-character blob where it
          // expects two fields, cannot recover the client challenge, and
          // answers REJECTED. So this mechanism has never authenticated
          // against a real bus. It went unnoticed because EXTERNAL is tried
          // first and succeeds on a unix socket, which leaves
          // DBUS_COOKIE_SHA1 mattering only over TCP.
          const reply = hexlify(`${clientChallenge} ${response}`);
          if (!send(stream, `DATA ${reply}\r\n`)) return;
          beginOrNextAuth();
        });
      });
      break;
    case 'ANONYMOUS':
      if (!send(stream, 'AUTH ANONYMOUS \r\n')) return;
      beginOrNextAuth();
      break;
    default:
      console.error(`Unsupported auth method: ${authMethod}`);
      beginOrNextAuth();
      break;
  }
}
