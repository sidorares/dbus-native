// UNIX_FD ('h'), and the transport seam that carries the descriptors.
//
// `h` used to throw in both directions with a long explanation. That explained
// the right thing in the wrong place: the type is not the problem. "The value
// is an index into the array of file descriptors that accompany the message"
// (D-Bus specification, Basic types) -- so `h` is a uint32 and always was. What
// is missing is a transport that can carry descriptors alongside the bytes,
// because they travel as ancillary data (SCM_RIGHTS) and Node has no API for
// it: nodejs/node#53391 is closed as not planned.
//
// So the capability lives on the stream. Supply one implementing
// `writeWithFds(bytes, fds)` that emits 'fds', and everything above it works --
// which is what these tests demonstrate, against a channel that does exactly
// that. See ROADMAP.md 2.8 for the transports that were measured and rejected.

const { describe, it } = require('node:test');
const assert = require('assert');
const marshall = require('../lib/marshall');
const unmarshall = require('../lib/unmarshall');
const parseSignature = require('../lib/signature');
const constants = require('../lib/constants');
const message = require('../lib/message');
const dbus = require('../index');
const { fdChannelPair, plainChannelPair } = require('./utils/fd-transport');

describe("UNIX_FD ('h') as a value", () => {
  it('parses as a signature, since it is a real type', () => {
    assert.deepStrictEqual(parseSignature('h'), [{ type: 'h', child: [] }]);
  });

  it('marshals as the uint32 index the spec says it is', () => {
    // Not a descriptor. An index into the fds that came with the message.
    const buffer = marshall('h', [2]);
    assert.strictEqual(buffer.length, 4);
    assert.deepStrictEqual(unmarshall(buffer, 'h'), [2]);
  });

  it('round-trips inside a container', () => {
    assert.deepStrictEqual(unmarshall(marshall('ah', [[0, 1, 2]]), 'ah'), [
      [0, 1, 2]
    ]);
    assert.deepStrictEqual(unmarshall(marshall('(sh)', [['x', 1]]), '(sh)'), [
      ['x', 1]
    ]);
  });

  it('rejects a value outside uint32 range, like any index', () => {
    assert.throws(() => marshall('h', [-1]), /Number outside range/);
  });

  it('leaves genuinely unknown types with the generic message', () => {
    assert.strictEqual(
      constants.unsupportedType('Z'),
      'Unknown data type format: Z'
    );
  });
});

describe('the UNIX_FDS header field', () => {
  it('is field 9, and used to land on the key "undefined"', () => {
    // Before this it was absent from the table, so a peer that sent one
    // produced `msg.undefined = 2`. Harmless only because we never negotiated
    // fd passing, so nothing ever sent it.
    assert.strictEqual(constants.headerTypeName[9], 'unixFds');
    assert.strictEqual(constants.headerTypeId.unixFds, 9);
    assert.strictEqual(constants.fieldSignature.unixFds, 'u');
  });

  it('is derived from msg.fds rather than set by the caller', () => {
    // The header and the ancillary data disagreeing is a desynchronised
    // connection, not a bad message: the peer takes the count it was told.
    const buffer = message.marshall({
      serial: 1,
      type: constants.messageType.methodCall,
      path: '/x',
      member: 'M',
      signature: 'h',
      body: [0],
      fds: [7, 8]
    });
    // Field 9 present, carrying 2.
    assert.ok(buffer.includes(Buffer.from([9, 1, 117, 0])), 'field 9 as a `u`');
  });

  it('is absent when there are no descriptors', () => {
    const buffer = message.marshall({
      serial: 1,
      type: constants.messageType.methodCall,
      path: '/x',
      member: 'M'
    });
    assert.ok(!buffer.includes(Buffer.from([9, 1, 117, 0])));
  });
});

describe('the transport seam', () => {
  // Two connected peers, speaking d-bus directly rather than through a bus.
  const connectPair = channels =>
    new Promise(resolve => {
      const [left, right] = channels;
      const server = dbus.createConnection({ stream: left, server: true });
      const client = dbus.createConnection({ stream: right, direct: true });
      let ready = 0;
      const done = () => ++ready === 2 && resolve({ server, client });
      server.on('connect', done);
      client.on('connect', done);
    });

  const nextMessage = conn =>
    new Promise(resolve => conn.once('message', resolve));

  it('reports whether this connection can carry descriptors', async () => {
    const { server, client } = await connectPair(fdChannelPair());
    assert.strictEqual(client.canPassFds, true);
    assert.strictEqual(server.canPassFds, true);

    const plain = await connectPair(plainChannelPair());
    assert.strictEqual(plain.client.canPassFds, false);
  });

  it('negotiates NEGOTIATE_UNIX_FD only when the transport can', async () => {
    const { client } = await connectPair(fdChannelPair());
    assert.strictEqual(client.unixFdsAgreed, true);

    // The same handshake over a stream that cannot: the client never asks, so
    // there is nothing for the server to agree to. Claiming the capability and
    // then failing on the first `h` would be worse than not claiming it.
    const plain = await connectPair(plainChannelPair());
    assert.strictEqual(plain.client.unixFdsAgreed, false);
  });

  it('carries descriptors with the message that claims them', async () => {
    const { server, client } = await connectPair(fdChannelPair());
    const arriving = nextMessage(server);

    client.message({
      serial: 1,
      type: constants.messageType.methodCall,
      path: '/com/example/Fd',
      member: 'Take',
      signature: 'sh',
      body: ['a file', 0],
      fds: [42]
    });

    const msg = await arriving;
    assert.strictEqual(msg.unixFds, 1);
    assert.deepStrictEqual(msg.fds, [42]);
    // The body carries the index; the descriptor is on the message.
    assert.deepStrictEqual(msg.body, ['a file', 0]);
    assert.strictEqual(msg.fds[msg.body[1]], 42);
  });

  it('gives each message its own share, in order', async () => {
    // The property that makes counting sufficient: SCM_RIGHTS delivers fds in
    // the same order as the bytes they accompanied, so message N takes the
    // next N descriptors rather than needing to be told which.
    const { server, client } = await connectPair(fdChannelPair());
    const seen = [];
    server.on('message', msg => seen.push(msg.fds));

    client.message({
      serial: 1,
      type: constants.messageType.methodCall,
      path: '/x',
      member: 'A',
      signature: 'ah',
      body: [[0, 1]],
      fds: [10, 11]
    });
    client.message({
      serial: 2,
      type: constants.messageType.methodCall,
      path: '/x',
      member: 'B',
      signature: 'h',
      body: [0],
      fds: [12]
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepStrictEqual(seen, [[10, 11], [12]]);
  });

  it('does not batch an fd message in with the others', async () => {
    // Ancillary data attaches to a *write*, not to a message. Batched, a
    // descriptor would land on whichever message the kernel associated it
    // with -- so an fd-carrying message flushes the cork and goes alone.
    const [left, right] = fdChannelPair();
    const { server, client } = await connectPair([left, right]);
    const seen = [];
    server.on('message', msg => seen.push([msg.member, msg.fds]));

    // Same tick: without the flush these would share one write.
    client.message({
      serial: 1,
      type: constants.messageType.methodCall,
      path: '/x',
      member: 'Plain'
    });
    client.message({
      serial: 2,
      type: constants.messageType.methodCall,
      path: '/x',
      member: 'WithFd',
      signature: 'h',
      body: [0],
      fds: [99]
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepStrictEqual(seen, [
      ['Plain', undefined],
      ['WithFd', [99]]
    ]);
    // Exactly one write carried descriptors, and it carried only its own.
    assert.strictEqual(right.sentWithFds.length, 1);
    assert.deepStrictEqual(right.sentWithFds[0].fds, [99]);
  });

  it('refuses to send descriptors over a transport that cannot', async () => {
    const { client } = await connectPair(plainChannelPair());
    assert.throws(
      () =>
        client.message({
          serial: 1,
          type: constants.messageType.methodCall,
          path: '/x',
          member: 'M',
          signature: 'h',
          body: [0],
          fds: [3]
        }),
      err => {
        assert.match(err.message, /carries file descriptors/);
        assert.match(err.message, /ancillary data \(SCM_RIGHTS\)/);
        // Points at the reason and the way out, not at this library.
        assert.match(err.message, /nodejs\/node\/issues\/53391/);
        assert.match(err.message, /opts\.stream/);
        return true;
      }
    );
  });

  it('sends an ordinary message over a plain transport unchanged', async () => {
    const { server, client } = await connectPair(plainChannelPair());
    const arriving = nextMessage(server);
    client.message({
      serial: 1,
      type: constants.messageType.methodCall,
      path: '/x',
      member: 'M',
      signature: 's',
      body: ['no descriptors here']
    });
    const msg = await arriving;
    assert.deepStrictEqual(msg.body, ['no descriptors here']);
    assert.strictEqual(msg.fds, undefined);
  });

  it('refuses a message claiming descriptors it cannot have received', async () => {
    // A header saying 2 with nothing to take is not a message we can deliver
    // correctly -- the body is full of indices into nothing. Better to say so
    // than to hand it over.
    const { server, client } = await connectPair(plainChannelPair());
    const failed = new Promise(resolve => server.once('error', resolve));

    // Bypass the connection's own refusal by writing the bytes directly.
    client.stream.write(
      message.marshall({
        serial: 1,
        type: constants.messageType.methodCall,
        path: '/x',
        member: 'M',
        signature: 'h',
        body: [0],
        fds: [3]
      })
    );

    const err = await failed;
    assert.match(err.message, /carries file descriptors/);
    assert.match(err.message, /received/);
  });
});
