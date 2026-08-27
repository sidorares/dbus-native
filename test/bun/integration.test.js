// A file descriptor through a real dbus-daemon, under Bun.
//
//   node scripts/with-dbus.js -- bun test test/bun    (npm run test:bun:integration)
//
// Two connections to the same bus, one descriptor, and the daemon in the
// middle doing the routing. This is the whole feature end to end -- the
// handshake agreeing UNIX_FD, the UNIX_FDS header, `h` as an index, and
// SCM_RIGHTS underneath -- and it is the case E2E_DOCKER_TESTING.md lists as
// impossible, because until this transport existed it was.

const { describe, it, expect, beforeAll, afterAll } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbus = require('../../index.js');
const constants = require('../../lib/constants');

const NO_BUS = !process.env.DBUS_SESSION_BUS_ADDRESS;

/** A connection that has finished saying Hello, so it has a unique name. */
function connected() {
  const bus = dbus.sessionBus();
  return new Promise((resolve, reject) => {
    bus.invokeDbus({ member: 'GetId' }, err => {
      if (err) return reject(err);
      resolve(bus);
    });
  });
}

function payload(contents) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-fd-e2e-')),
    'payload'
  );
  fs.writeFileSync(file, contents);
  return fs.openSync(file, 'r');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(NO_BUS)('a descriptor through a real bus', () => {
  let sender;
  let receiver;

  beforeAll(async () => {
    sender = await connected();
    receiver = await connected();
  });

  afterAll(() => {
    for (const bus of [sender, receiver]) {
      if (bus) bus.connection.end();
    }
  });

  it('negotiates UNIX_FD with the daemon', () => {
    // Both halves: our transport can carry one, and the peer agreed to it.
    expect(sender.connection.canPassFds).toBe(true);
    expect(sender.connection.unixFdsAgreed).toBe(true);
  });

  it('carries one from client to client, with the daemon in between', async () => {
    const received = [];
    receiver.connection.on('message', msg => {
      if (msg.member === 'Take') received.push(msg);
    });

    const fd = payload('through-the-daemon\n');
    sender.connection.message({
      type: constants.messageType.methodCall,
      serial: sender.nextSerial(),
      destination: receiver.name,
      path: '/org/dbusnative/FdTest',
      interface: 'org.dbusnative.FdTest',
      member: 'Take',
      signature: 'sh',
      // The `h` is an index into the descriptors that accompany the message,
      // not a descriptor -- which is the whole point of the type.
      body: ['a name', 0],
      fds: [fd],
      flags: constants.flags.noReplyExpected
    });
    fs.closeSync(fd);

    for (let i = 0; i < 200 && received.length === 0; i++) await sleep(10);
    expect(received).toHaveLength(1);

    const msg = received[0];
    expect(msg.body[0]).toBe('a name');
    expect(msg.unixFds).toBe(1);
    expect(msg.fds).toHaveLength(1);
    // The daemon passed the descriptor on rather than the number: this is a
    // different open file description in a different process, and reading it
    // is what proves it.
    const arrived = msg.fds[msg.body[1]];
    expect(fs.readFileSync(arrived, 'utf8')).toBe('through-the-daemon\n');
    fs.closeSync(arrived);
  });

  it('carries several, in the order the sender put them in', async () => {
    const received = [];
    receiver.connection.on('message', msg => {
      if (msg.member === 'TakeThree') received.push(msg);
    });

    const fds = [payload('one\n'), payload('two\n'), payload('three\n')];
    sender.connection.message({
      type: constants.messageType.methodCall,
      serial: sender.nextSerial(),
      destination: receiver.name,
      path: '/org/dbusnative/FdTest',
      interface: 'org.dbusnative.FdTest',
      member: 'TakeThree',
      signature: 'hhh',
      body: [2, 1, 0], // deliberately not in order: they are indices
      fds,
      flags: constants.flags.noReplyExpected
    });
    fds.forEach(fd => fs.closeSync(fd));

    for (let i = 0; i < 200 && received.length === 0; i++) await sleep(10);
    expect(received).toHaveLength(1);

    const msg = received[0];
    expect(msg.unixFds).toBe(3);
    const texts = msg.body.map(index => {
      const text = fs.readFileSync(msg.fds[index], 'utf8');
      return text;
    });
    msg.fds.forEach(fd => fs.closeSync(fd));
    expect(texts).toEqual(['three\n', 'two\n', 'one\n']);
  });

  it('still carries ordinary messages, in both directions', async () => {
    // The transport is the connection now, so the boring path has to keep
    // working: this is a round trip through the daemon and back.
    const id = await new Promise((resolve, reject) => {
      sender.invokeDbus({ member: 'GetId' }, (err, value) =>
        err ? reject(err) : resolve(value)
      );
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const names = await new Promise((resolve, reject) => {
      sender.listNames((err, value) => (err ? reject(err) : resolve(value)));
    });
    expect(names).toContain(receiver.name);
  });
});
