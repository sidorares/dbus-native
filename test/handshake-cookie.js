// DBUS_COOKIE_SHA1, the mechanism that matters when EXTERNAL cannot work.
//
// EXTERNAL is tried first and succeeds on a unix socket, so this one only
// comes up over TCP -- which is why a malformed response went unnoticed for
// years. The response carries two fields, and the space between them is not
// optional: without it the server sees one blob, cannot recover the client
// challenge, and answers REJECTED.
//
// https://dbus.freedesktop.org/doc/dbus-specification.html#auth-mechanisms-sha

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Duplex } = require('stream');
const auth = require('../lib/handshake');

const CONTEXT = 'org_freedesktop_general';
const COOKIE_ID = '162004020';
const COOKIE = 'e17968c5c097bff2fd50a93cfdf8a97c9acb39ba13d95bc5';
const SERVER_CHALLENGE = '6bb9ec9396d6bb47940780a6b60da269';

const hex = s => Buffer.from(String(s), 'ascii').toString('hex');
const unhex = s => Buffer.from(s, 'hex').toString('ascii');

// Captures what the client writes, and lets the test feed it server lines.
class FakeSocket extends Duplex {
  constructor() {
    super();
    this.written = [];
  }
  _write(chunk, enc, cb) {
    this.written.push(chunk.toString());
    cb();
  }
  _read() {}
  // Every complete line the client has written so far.
  lines() {
    return this.written.join('').split('\r\n').filter(Boolean);
  }
  reply(line) {
    this.push(`${line}\r\n`);
  }
}

// Wait until the client has written `n` lines (the '\0' rides on the first).
const until = (socket, n) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (socket.lines().length >= n) return resolve();
      if (Date.now() - started > 2000)
        return reject(new Error(`only ${socket.lines().length} lines written`));
      setImmediate(poll);
    };
    poll();
  });

describe('DBUS_COOKIE_SHA1', () => {
  let home, previousHome;

  before(() => {
    // getCookie() refuses a keyring directory that others can write or that
    // belongs to someone else, so 0700 and our own uid are both required.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-keyring-'));
    fs.mkdirSync(path.join(home, '.dbus-keyrings'), { mode: 0o700 });
    fs.writeFileSync(
      path.join(home, '.dbus-keyrings', CONTEXT),
      `${COOKIE_ID} 1700000000 ${COOKIE}\n`
    );
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });

  after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Runs the handshake to completion and hands back what was said.
  async function handshake() {
    const socket = new FakeSocket();
    const done = new Promise((resolve, reject) =>
      auth(socket, { authMethods: ['DBUS_COOKIE_SHA1'] }, (err, guid) =>
        err ? reject(err) : resolve(guid)
      )
    );

    await until(socket, 1);
    socket.reply(`DATA ${hex(`${CONTEXT} ${COOKIE_ID} ${SERVER_CHALLENGE}`)}`);

    await until(socket, 2);
    socket.reply('OK 326475c33141ef4255ca5ed96a69c063');

    return { socket, guid: await done };
  }

  it('sends AUTH with the hex-encoded uid', async () => {
    const { socket } = await handshake();
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    assert.strictEqual(
      socket.lines()[0],
      `\0AUTH DBUS_COOKIE_SHA1 ${hex(uid)}`
    );
  });

  it('separates the challenge and the digest with a space', async () => {
    const { socket } = await handshake();
    const payload = unhex(socket.lines()[1].slice('DATA '.length));
    const fields = payload.split(' ');
    assert.strictEqual(
      fields.length,
      2,
      `expected "<challenge> <digest>", got ${JSON.stringify(payload)}`
    );
  });

  it('digests server challenge, client challenge and cookie, in that order', async () => {
    const { socket } = await handshake();
    const [clientChallenge, digest] = unhex(
      socket.lines()[1].slice('DATA '.length)
    ).split(' ');

    const expected = crypto
      .createHash('sha1')
      .update([SERVER_CHALLENGE, clientChallenge, COOKIE].join(':'))
      .digest('hex');
    assert.strictEqual(digest, expected);
    assert.strictEqual(digest.length, 40, 'a hex sha1');
  });

  it('uses a fresh client challenge each time', async () => {
    const first = await handshake();
    const second = await handshake();
    const challenge = s =>
      unhex(s.lines()[1].slice('DATA '.length)).split(' ')[0];
    assert.notStrictEqual(challenge(first.socket), challenge(second.socket));
  });

  it('begins, and reports the server GUID', async () => {
    const { socket, guid } = await handshake();
    assert.strictEqual(socket.lines()[2], 'BEGIN');
    assert.strictEqual(guid, '326475c33141ef4255ca5ed96a69c063');
  });

  it('fails when the keyring has no cookie with that id', async () => {
    const socket = new FakeSocket();
    const done = new Promise(resolve =>
      auth(socket, { authMethods: ['DBUS_COOKIE_SHA1'] }, err => resolve(err))
    );
    await until(socket, 1);
    socket.reply(`DATA ${hex(`${CONTEXT} 999 ${SERVER_CHALLENGE}`)}`);
    assert.match((await done).message, /cookie not found/);
  });
});
