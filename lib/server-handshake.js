// The server half of the SASL handshake.
//
// https://dbus.freedesktop.org/doc/dbus-specification.html#auth-protocol
//
// What was here before was a transcript of someone's 2014 session replayed
// verbatim: a hardcoded cookie, a hardcoded GUID, an unconditional REJECTED
// followed by an OK that ignored whatever the client had said, and a
// console.log per connection. It authenticated nobody -- it only resembled a
// handshake if the client happened to ask its questions in that order.
//
// This is the state machine from the specification, three mechanisms, and a
// GUID generated per server.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const readLine = require('./readline');

// A connection that opens and then says nothing still costs a socket.
// dbus-daemon's own limit is 30 seconds.
const DEFAULT_AUTH_TIMEOUT = 30000;

// The spec has the server answer REJECTED and wait for another AUTH, which on
// its own is an unbounded loop for a client that keeps guessing.
const MAX_REJECTIONS = 8;

// Offered unless the caller says otherwise. ANONYMOUS is deliberately not
// among them: it authenticates nobody, and it should be turned on knowingly.
// dbus-daemon takes the same line with <allow_anonymous/>.
const DEFAULT_MECHANISMS = ['EXTERNAL', 'DBUS_COOKIE_SHA1'];

const DEFAULT_COOKIE_CONTEXT = 'org_freedesktop_general';

// How long a cookie stays usable, and how long it stays in the file. A cookie
// is only needed for the length of a handshake, and one left lying around is a
// credential, so both are short.
const COOKIE_LIFETIME_MS = 5 * 60 * 1000;
const COOKIE_RETENTION_MS = 10 * 60 * 1000;

const KNOWN_COMMANDS = [
  'AUTH',
  'DATA',
  'BEGIN',
  'CANCEL',
  'ERROR',
  'NEGOTIATE_UNIX_FD'
];

const hex = value => Buffer.from(String(value), 'ascii').toString('hex');
const unhex = value => Buffer.from(value, 'hex').toString('ascii');
const sha1 = input => crypto.createHash('sha1').update(input).digest('hex');

/** A D-Bus GUID: 16 random bytes as lower-case hex. */
function generateGuid() {
  return crypto.randomBytes(16).toString('hex');
}

// As in lib/handshake.js: writing to a stream the peer has already dropped is
// not an error worth reporting.
function writable(stream) {
  return (
    !stream.writableEnded && !stream.destroyed && stream.writable !== false
  );
}

/**
 * A cookie the client can be expected to find in its own keyring, creating one
 * if there is nothing usable.
 *
 * The file holds a line per cookie: id, creation time in seconds, and the
 * cookie in hex. Entries past their retention are dropped on the way through,
 * so the file does not grow without bound and an old credential does not sit
 * on disk indefinitely.
 */
function ensureCookie(context, cb) {
  const file = path.join(os.homedir(), '.dbus-keyrings', context);
  const dir = path.dirname(file);
  let entries = [];
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A keyring anyone can write is a keyring anyone can authenticate with.
    // The client checks this before trusting the directory; so do we.
    if (fs.statSync(dir).mode & 0o022) {
      return cb(
        new Error(`${dir} is writable by other users; refusing to use it`)
      );
    }
    if (fs.existsSync(file)) {
      entries = fs
        .readFileSync(file, 'ascii')
        .split('\n')
        .map(line => line.split(' '))
        .filter(fields => fields.length === 3);
    }
  } catch (err) {
    return cb(err);
  }

  const now = Date.now();
  const age = fields => now - Number(fields[1]) * 1000;
  const kept = entries.filter(fields => age(fields) < COOKIE_RETENTION_MS);
  const usable = kept.find(fields => age(fields) < COOKIE_LIFETIME_MS);

  if (usable && kept.length === entries.length) {
    return cb(null, { id: usable[0], cookie: usable[2] });
  }

  const entry = usable || [
    String(crypto.randomInt(1, 2 ** 31)),
    String(Math.floor(now / 1000)),
    crypto.randomBytes(24).toString('hex')
  ];
  const lines = usable ? kept : [...kept, entry];
  try {
    fs.writeFileSync(file, `${lines.map(f => f.join(' ')).join('\n')}\n`, {
      mode: 0o600
    });
  } catch (err) {
    return cb(err);
  }
  return cb(null, { id: entry[0], cookie: entry[2] });
}

/**
 * Run the server side of the handshake on `stream`.
 *
 * `opts`:
 *   guid           this server's GUID; generated when absent
 *   authMethods    mechanisms to offer, in the order they are advertised
 *   anonymous      also offer ANONYMOUS
 *   authorize      ({mechanism, uid}) => boolean, the last word on accepting
 *   cookieContext  keyring context used by DBUS_COOKIE_SHA1
 *   authTimeout    ms before an unauthenticated connection is dropped; 0 waits
 *
 * Calls back with `(null, guid, identity)` once the client has sent BEGIN.
 */
module.exports = function serverHandshake(stream, opts, cb) {
  opts = opts || {};
  const guid = opts.guid || generateGuid();
  const mechanisms = (opts.authMethods || DEFAULT_MECHANISMS).slice();
  if (opts.anonymous && !mechanisms.includes('ANONYMOUS')) {
    mechanisms.push('ANONYMOUS');
  }
  const cookieContext = opts.cookieContext || DEFAULT_COOKIE_CONTEXT;
  const authorize = opts.authorize;

  let state = 'WaitingForAuth';
  let rejections = 0;
  let firstLine = true;
  let settled = false;
  // Whether we told the client it may send descriptors on this connection.
  let unixFdAgreed = false;
  // Set while a mechanism is mid-exchange, so a DATA line knows who wants it.
  let pending = null;
  // What we learnt about the peer; passed to `authorize` and to the caller.
  const identity = { mechanism: null, uid: null };

  const timeout =
    opts.authTimeout === undefined ? DEFAULT_AUTH_TIMEOUT : opts.authTimeout;
  const timer =
    timeout > 0
      ? setTimeout(
          () =>
            fail(new Error('Timed out waiting for the client to authenticate')),
          timeout
        )
      : null;

  function send(line) {
    if (!writable(stream)) return false;
    stream.write(`${line}\r\n`);
    return true;
  }

  function fail(error) {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    stream.end();
    cb(error);
  }

  function succeed() {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    cb(null, guid, identity, { unixFd: unixFdAgreed });
  }

  // Refuse this attempt and let the client try again with another mechanism,
  // which is what REJECTED means.
  function reject() {
    pending = null;
    state = 'WaitingForAuth';
    if (++rejections > MAX_REJECTIONS) {
      return fail(
        new Error(
          `Client failed to authenticate after ${MAX_REJECTIONS} attempts`
        )
      );
    }
    if (send(`REJECTED ${mechanisms.join(' ')}`)) next();
  }

  function next() {
    if (settled) return;
    readLine(stream, line => {
      if (settled) return;
      let text = line.toString('ascii');
      if (firstLine) {
        firstLine = false;
        // "Immediately after connecting to the server, the client must send a
        // single nul byte." It arrives in front of the first command rather
        // than on a line of its own.
        if (text[0] !== '\0') {
          return fail(new Error('Client did not send the initial nul byte'));
        }
        text = text.slice(1);
      }
      handle(text.replace(/\r$/, ''));
    });
  }

  function handle(line) {
    const space = line.indexOf(' ');
    const command = space === -1 ? line : line.slice(0, space);
    const argument = space === -1 ? '' : line.slice(space + 1).trim();

    // BEGIN before authentication cannot be answered: the client has stopped
    // speaking SASL, so there is nothing left to say to it.
    if (command === 'BEGIN' && state !== 'WaitingForBegin') {
      return fail(new Error(`Client sent BEGIN while ${state}`));
    }
    // "If a client or server receives an unknown command it shall respond with
    // ERROR and not consider this fatal."
    if (!KNOWN_COMMANDS.includes(command)) {
      send(`ERROR Unknown command "${command}"`);
      return next();
    }
    // From any state, both of these mean "start over".
    if (command === 'CANCEL' || command === 'ERROR') return reject();

    switch (state) {
      case 'WaitingForAuth':
        return onAuth(command, argument);
      case 'WaitingForData':
        return onData(command, argument);
      default:
        return onBegin(command);
    }
  }

  function onAuth(command, argument) {
    if (command !== 'AUTH') {
      send(`ERROR Expected AUTH, got ${command}`);
      return next();
    }
    // A bare AUTH asks what is on offer, and REJECTED is how that is answered.
    if (argument === '') return reject();

    const space = argument.indexOf(' ');
    const mechanism = space === -1 ? argument : argument.slice(0, space);
    const initial = space === -1 ? null : argument.slice(space + 1).trim();

    if (!mechanisms.includes(mechanism)) return reject();
    identity.mechanism = mechanism;

    switch (mechanism) {
      case 'EXTERNAL':
        return external(initial);
      case 'ANONYMOUS':
        // The argument is a free-text trace string, of interest to nobody.
        return accept();
      case 'DBUS_COOKIE_SHA1':
        return cookieChallenge();
      default:
        return reject();
    }
  }

  function onData(command, argument) {
    if (command !== 'DATA') {
      send(`ERROR Expected DATA, got ${command}`);
      return next();
    }
    const handler = pending;
    pending = null;
    if (!handler) return reject();
    return handler(argument);
  }

  function onBegin(command) {
    if (command === 'BEGIN') return succeed();
    if (command === 'NEGOTIATE_UNIX_FD') {
      // Agreed only if this connection's transport can actually carry a
      // descriptor. Nothing in this package provides one -- a descriptor
      // travels as ancillary data and Node has no API for it, ROADMAP 2.8 --
      // so this is ERROR unless the caller supplied a stream that can, which
      // is the seam. The client carries on either way; ERROR here means "not
      // on this connection", not "handshake failed".
      if (typeof stream.writeWithFds === 'function') {
        unixFdAgreed = true;
        send('AGREE_UNIX_FD');
      } else {
        send('ERROR UNIX_FD passing is not supported');
      }
      return next();
    }
    send(`ERROR Expected BEGIN, got ${command}`);
    return next();
  }

  // EXTERNAL. The client offers its uid, and the spec has the server check it
  // against credentials the transport supplies out of band. Node exposes no
  // such thing -- there is no SO_PEERCRED -- so the claim cannot be verified
  // here. The default is therefore the narrowest useful rule: the peer must
  // claim to be the user this process runs as, which is what a private
  // per-user bus wants. `authorize` replaces that judgement outright.
  function external(initial) {
    if (!initial) {
      // An empty response means "use the out-of-band credentials", which we do
      // not have. Asking for the uid is the only way we can answer at all.
      pending = data => external(data);
      state = 'WaitingForData';
      if (send('DATA')) next();
      return;
    }
    const uid = unhex(initial);
    if (!/^\d+$/.test(uid)) return reject();
    identity.uid = Number(uid);
    if (!authorize && typeof process.getuid === 'function') {
      if (identity.uid !== process.getuid()) return reject();
    }
    return accept();
  }

  // DBUS_COOKIE_SHA1. We name a cookie the client should be able to read from
  // its own keyring, plus a challenge; it proves it read the cookie.
  function cookieChallenge() {
    ensureCookie(cookieContext, (err, entry) => {
      if (err) return fail(err);
      const challenge = crypto.randomBytes(16).toString('hex');
      pending = data => verifyCookie(entry, challenge, data);
      state = 'WaitingForData';
      if (send(`DATA ${hex(`${cookieContext} ${entry.id} ${challenge}`)}`)) {
        next();
      }
    });
  }

  function verifyCookie(entry, challenge, data) {
    const [clientChallenge, digest] = unhex(data).split(' ');
    if (!clientChallenge || !digest) return reject();
    const expected = sha1([challenge, clientChallenge, entry.cookie].join(':'));
    // Compared without a short circuit: the digest is derived from a secret,
    // and how long the comparison takes is a hint about it.
    const offered = Buffer.from(digest, 'ascii');
    const wanted = Buffer.from(expected, 'ascii');
    if (
      offered.length !== wanted.length ||
      !crypto.timingSafeEqual(offered, wanted)
    ) {
      return reject();
    }
    return accept();
  }

  function accept() {
    if (authorize && !authorize({ ...identity })) return reject();
    state = 'WaitingForBegin';
    if (send(`OK ${guid}`)) next();
  }

  // The client can go away at any point in the conversation.
  stream.once('end', () =>
    fail(new Error('Client closed the connection during authentication'))
  );

  next();
};

module.exports.generateGuid = generateGuid;
