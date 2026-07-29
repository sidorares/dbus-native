// The server half of the SASL handshake.
//
// https://dbus.freedesktop.org/doc/dbus-specification.html#auth-protocol
//
// Two kinds of test here: the happy paths run our own client against our own
// server, so both halves have to agree; the protocol cases script a raw client
// by hand, because a well-behaved client will not send BEGIN out of turn.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough, Duplex } = require('stream');

const clientAuth = require('../lib/handshake');
const serverAuth = require('../lib/server-handshake');

const hex = value => Buffer.from(String(value), 'ascii').toString('hex');
const unhex = value => Buffer.from(value, 'hex').toString('ascii');
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;

// Two ends of one conversation, without going near a socket.
function pair() {
  const up = new PassThrough();
  const down = new PassThrough();
  return {
    client: Duplex.from({ readable: down, writable: up }),
    server: Duplex.from({ readable: up, writable: down })
  };
}

// A client we drive by hand: writes bytes, collects the server's lines.
function rawClient(stream) {
  const lines = [];
  let buffer = '';
  stream.on('data', chunk => {
    buffer += chunk.toString('ascii');
    let at;
    while ((at = buffer.indexOf('\r\n')) !== -1) {
      lines.push(buffer.slice(0, at));
      buffer = buffer.slice(at + 2);
    }
  });
  return {
    lines,
    write: text => stream.write(text),
    send: line => stream.write(`${line}\r\n`),
    // Resolves with the next line the server sends after the ones already seen.
    async expect(n = lines.length + 1) {
      const started = Date.now();
      while (lines.length < n) {
        if (Date.now() - started > 2000) {
          throw new Error(`server said only: ${JSON.stringify(lines)}`);
        }
        await new Promise(resolve => setImmediate(resolve));
      }
      return lines[n - 1];
    }
  };
}

// Runs a server handshake and resolves with how it ended.
function runServer(stream, opts) {
  return new Promise(resolve =>
    serverAuth(stream, { authTimeout: 0, ...opts }, (err, guid, identity) =>
      resolve({ err, guid, identity })
    )
  );
}

describe('server handshake: with our own client', { timeout: 10000 }, () => {
  const both = async (serverOpts, clientOpts) => {
    const { client, server } = pair();
    const serverDone = runServer(server, serverOpts);
    const c = await new Promise(resolve =>
      clientAuth(client, clientOpts, (err, guid) => resolve({ err, guid }))
    );
    // A client that has run out of mechanisms stops talking without saying so.
    // A real socket would close; here we have to do it, or the server sits in
    // WaitingForAuth for as long as its timeout allows.
    if (c.err) client.end();
    return [await serverDone, c];
  };

  it('authenticates EXTERNAL, and both ends agree on the GUID', async () => {
    const [s, c] = await both(
      { authMethods: ['EXTERNAL'] },
      { authMethods: ['EXTERNAL'] }
    );
    assert.ifError(s.err);
    assert.ifError(c.err);
    assert.strictEqual(c.guid, s.guid);
    assert.match(s.guid, /^[0-9a-f]{32}$/, 'a D-Bus GUID');
    assert.deepStrictEqual(s.identity, { mechanism: 'EXTERNAL', uid: UID });
  });

  it('generates a different GUID per server, and honours a given one', async () => {
    const [a] = await both({ authMethods: ['EXTERNAL'] }, {});
    const [b] = await both({ authMethods: ['EXTERNAL'] }, {});
    assert.notStrictEqual(a.guid, b.guid);

    const fixed = 'ffeeddccbbaa99887766554433221100';
    const [c] = await both({ authMethods: ['EXTERNAL'], guid: fixed }, {});
    assert.strictEqual(c.guid, fixed);
  });

  it('lets the client fall through to a mechanism the server offers', async () => {
    // The client tries EXTERNAL first; the server only speaks ANONYMOUS.
    const [s, c] = await both(
      { authMethods: ['ANONYMOUS'] },
      { authMethods: ['EXTERNAL', 'ANONYMOUS'] }
    );
    assert.ifError(s.err);
    assert.ifError(c.err);
    assert.strictEqual(s.identity.mechanism, 'ANONYMOUS');
  });

  it('does not offer ANONYMOUS unless asked to', async () => {
    const [s, c] = await both({}, { authMethods: ['ANONYMOUS'] });
    assert.match(c.err.message, /No authentication methods left to try/);
    assert.ok(s.err, 'and the server never authenticated anyone');
  });

  it('offers ANONYMOUS when anonymous is set', async () => {
    const [s] = await both({ anonymous: true }, { authMethods: ['ANONYMOUS'] });
    assert.ifError(s.err);
    assert.strictEqual(s.identity.mechanism, 'ANONYMOUS');
  });
});

describe('server handshake: DBUS_COOKIE_SHA1', { timeout: 10000 }, () => {
  let home, previousHome;

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-server-keyring-'));
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });

  after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('challenges, and accepts a client that knows the cookie', async () => {
    const { client, server } = pair();
    const [s, c] = await Promise.all([
      runServer(server, { authMethods: ['DBUS_COOKIE_SHA1'] }),
      new Promise(resolve =>
        clientAuth(client, { authMethods: ['DBUS_COOKIE_SHA1'] }, (err, guid) =>
          resolve({ err, guid })
        )
      )
    ]);
    assert.ifError(s.err);
    assert.ifError(c.err);
    assert.strictEqual(c.guid, s.guid);
    assert.strictEqual(s.identity.mechanism, 'DBUS_COOKIE_SHA1');
  });

  it('creates the keyring it needs, readable only by its owner', async () => {
    const file = path.join(home, '.dbus-keyrings', 'org_freedesktop_general');
    assert.ok(fs.existsSync(file), 'the keyring was written');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    const [id, created, cookie] = fs
      .readFileSync(file, 'ascii')
      .trim()
      .split('\n')[0]
      .split(' ');
    assert.match(id, /^\d+$/);
    assert.ok(Number(created) > 1600000000, 'seconds since the epoch');
    assert.match(cookie, /^[0-9a-f]{48}$/);
  });

  it('rejects a digest that does not match the challenge', async () => {
    const { client, server } = pair();
    const raw = rawClient(client);
    const done = runServer(server, {
      authMethods: ['DBUS_COOKIE_SHA1'],
      authTimeout: 0
    });

    raw.write('\0');
    raw.send(`AUTH DBUS_COOKIE_SHA1 ${hex(UID)}`);
    const challenge = await raw.expect(1);
    assert.match(challenge, /^DATA /);

    raw.send(`DATA ${hex(`deadbeef ${'0'.repeat(40)}`)}`);
    assert.match(await raw.expect(2), /^REJECTED /);

    client.end();
    assert.ok((await done).err, 'and the handshake does not complete');
  });

  it('uses the cookie the client can actually read', async () => {
    // The server names an id from the shared keyring; a client that reads the
    // same file must find it. This is the round trip that a missing space in
    // the client's response used to break.
    const { client, server } = pair();
    const raw = rawClient(client);
    runServer(server, { authMethods: ['DBUS_COOKIE_SHA1'], authTimeout: 0 });

    raw.write('\0');
    raw.send(`AUTH DBUS_COOKIE_SHA1 ${hex(UID)}`);
    const payload = unhex((await raw.expect(1)).slice('DATA '.length));
    const [context, id, challenge] = payload.split(' ');
    assert.strictEqual(context, 'org_freedesktop_general');

    const keyring = fs
      .readFileSync(path.join(home, '.dbus-keyrings', context), 'ascii')
      .split('\n')
      .map(line => line.split(' '))
      .find(fields => fields[0] === id);
    assert.ok(keyring, 'the id names a cookie in the file');

    const clientChallenge = crypto.randomBytes(16).toString('hex');
    const digest = crypto
      .createHash('sha1')
      .update([challenge, clientChallenge, keyring[2]].join(':'))
      .digest('hex');
    raw.send(`DATA ${hex(`${clientChallenge} ${digest}`)}`);
    assert.match(await raw.expect(2), /^OK [0-9a-f]{32}$/);
  });
});

describe('server handshake: the protocol', { timeout: 10000 }, () => {
  // Starts a server and a hand-driven client that has sent its nul byte.
  const scripted = opts => {
    const { client, server } = pair();
    const raw = rawClient(client);
    const done = runServer(server, { authTimeout: 0, ...opts });
    raw.write('\0');
    return { raw, done, client, server };
  };

  it('answers a bare AUTH with the mechanisms it offers', async () => {
    const { raw } = scripted({ authMethods: ['EXTERNAL', 'DBUS_COOKIE_SHA1'] });
    raw.send('AUTH');
    assert.strictEqual(
      await raw.expect(1),
      'REJECTED EXTERNAL DBUS_COOKIE_SHA1'
    );
  });

  it('rejects a mechanism it does not offer, and keeps listening', async () => {
    const { raw } = scripted({ authMethods: ['EXTERNAL'] });
    raw.send('AUTH KERBEROS_V4 abc');
    assert.strictEqual(await raw.expect(1), 'REJECTED EXTERNAL');
    raw.send(`AUTH EXTERNAL ${hex(UID)}`);
    assert.match(await raw.expect(2), /^OK /);
  });

  it('answers an unknown command with ERROR and carries on', async () => {
    // "If a client or server receives an unknown command it shall respond
    // with ERROR and not consider this fatal."
    const { raw } = scripted({ authMethods: ['EXTERNAL'] });
    raw.send('WHAT IS THIS');
    assert.match(await raw.expect(1), /^ERROR Unknown command "WHAT"/);
    raw.send(`AUTH EXTERNAL ${hex(UID)}`);
    assert.match(await raw.expect(2), /^OK /);
  });

  it('refuses UNIX_FD passing but stays in the handshake', async () => {
    const { raw, done } = scripted({ authMethods: ['EXTERNAL'] });
    raw.send(`AUTH EXTERNAL ${hex(UID)}`);
    await raw.expect(1);
    raw.send('NEGOTIATE_UNIX_FD');
    assert.match(await raw.expect(2), /^ERROR .*UNIX_FD/);
    raw.send('BEGIN');
    assert.ifError((await done).err);
  });

  it('starts over on CANCEL', async () => {
    const { raw } = scripted({ authMethods: ['EXTERNAL'] });
    raw.send('AUTH EXTERNAL');
    assert.strictEqual(await raw.expect(1), 'DATA', 'asked for the uid');
    raw.send('CANCEL');
    assert.strictEqual(await raw.expect(2), 'REJECTED EXTERNAL');
    raw.send(`AUTH EXTERNAL ${hex(UID)}`);
    assert.match(await raw.expect(3), /^OK /);
  });

  it('gives up on a client that only ever guesses', async () => {
    const { raw, done } = scripted({ authMethods: ['EXTERNAL'] });
    for (let i = 0; i < 12; i++) raw.send('AUTH NOPE');
    assert.match((await done).err.message, /failed to authenticate after/);
  });

  it('treats BEGIN before authentication as fatal', async () => {
    const { raw, done } = scripted({ authMethods: ['EXTERNAL'] });
    raw.send('BEGIN');
    assert.match((await done).err.message, /BEGIN while WaitingForAuth/);
  });

  it('requires the initial nul byte', async () => {
    const { client, server } = pair();
    const done = runServer(server, { authTimeout: 0 });
    client.write(`AUTH EXTERNAL ${hex(UID)}\r\n`);
    assert.match((await done).err.message, /initial nul byte/);
  });

  it('drops a connection that never authenticates', async () => {
    const { server } = pair();
    const { err } = await runServer(server, { authTimeout: 40 });
    assert.match(err.message, /Timed out waiting/);
  });

  it('reports a client that hangs up mid-handshake', async () => {
    const { raw, done, client } = scripted({ authMethods: ['EXTERNAL'] });
    raw.send('AUTH EXTERNAL');
    await raw.expect(1);
    client.end();
    assert.match((await done).err.message, /closed the connection/);
  });

  it('leaves the bytes after BEGIN on the stream', async () => {
    // The first message can share a packet with BEGIN. Swallowing it would
    // desynchronise the connection before it had carried anything.
    const { raw, done, server } = scripted({ authMethods: ['EXTERNAL'] });
    raw.send(`AUTH EXTERNAL ${hex(UID)}`);
    await raw.expect(1);
    raw.write('BEGIN\r\nMESSAGEBYTES');
    assert.ifError((await done).err);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(server.read().toString(), 'MESSAGEBYTES');
  });
});

describe('server handshake: who is allowed in', { timeout: 10000 }, () => {
  const external = (opts, uid) => {
    const { client, server } = pair();
    const raw = rawClient(client);
    const done = runServer(server, {
      authMethods: ['EXTERNAL'],
      authTimeout: 0,
      ...opts
    });
    raw.write('\0');
    raw.send(`AUTH EXTERNAL ${hex(uid)}`);
    return { raw, done };
  };

  it('accepts a peer claiming to be the user we are running as', async () => {
    const { raw } = external({}, UID);
    assert.match(await raw.expect(1), /^OK /);
  });

  it('rejects a peer claiming to be somebody else', async () => {
    // Node cannot read the peer's real credentials, so the claim is all there
    // is; the narrowest useful default is to require it to be our own uid.
    const { raw } = external({}, UID + 1);
    assert.match(await raw.expect(1), /^REJECTED/);
  });

  it('rejects a uid that is not a number', async () => {
    const { raw } = external({}, 'root');
    assert.match(await raw.expect(1), /^REJECTED/);
  });

  it('hands the decision to authorize when one is given', async () => {
    const seen = [];
    const { raw } = external(
      {
        authorize: info => {
          seen.push(info);
          return info.uid === 4242;
        }
      },
      4242
    );
    assert.match(await raw.expect(1), /^OK /);
    assert.deepStrictEqual(seen, [{ mechanism: 'EXTERNAL', uid: 4242 }]);
  });

  it('lets authorize refuse someone the default would allow', async () => {
    const { raw } = external({ authorize: () => false }, UID);
    assert.match(await raw.expect(1), /^REJECTED/);
  });
});
