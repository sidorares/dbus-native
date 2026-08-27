// lib/transport-bun.js against a real unix socket, both directions.
//
// Run with `npm run test:bun`. These are the only tests in the suite that
// cannot run on Node: the transport under test does not exist there.

const { describe, it, expect, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const transport = require('../../lib/transport-bun');
const { listenAt, sleep } = require('./peer');

const open = [];

function socketPath(name) {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-fd-')),
    `${name}.sock`
  );
  return p;
}

/** A file with known contents, to send as a descriptor and read back. */
function payload(contents) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-fd-')),
    'payload'
  );
  fs.writeFileSync(file, contents);
  return { fd: fs.openSync(file, 'r'), file, contents };
}

/** A connected { stream, peer } pair, torn down after each test. */
function pair(name, target) {
  const where = target || { path: socketPath(name) };
  const peer = listenAt(where);
  const stream = transport.connect(where);
  expect(stream).not.toBe(null);
  peer.accept();
  open.push({ stream, peer });
  return { stream, peer };
}

afterEach(() => {
  for (const { stream, peer } of open.splice(0, open.length)) {
    stream.destroy();
    peer.close();
  }
});

describe('the Bun fd transport', () => {
  it('is available under Bun', () => {
    expect(transport.available()).toBe(true);
  });

  it('looks like the seam the connection expects', () => {
    const { stream } = pair('seam');
    // What index.js probes for: writeWithFds is the capability declaration,
    // cork/uncork is what lets messages without descriptors batch.
    expect(typeof stream.writeWithFds).toBe('function');
    expect(typeof stream.cork).toBe('function');
    expect(typeof stream.uncork).toBe('function');
    expect(typeof stream.read).toBe('function');
  });
});

describe('sending descriptors', () => {
  it('puts them on the wire with their own bytes', async () => {
    const { stream, peer } = pair('send');
    const { fd, contents } = payload('sent-through-the-socket\n');

    stream.writeWithFds(Buffer.from('carrier'), [fd]);

    await peer.readAtLeast(7);
    const arrivals = await peer.readUntilFds();
    expect(peer.bytes.toString()).toBe('carrier');
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].fds).toHaveLength(1);
    expect(fs.readFileSync(arrivals[0].fds[0], 'utf8')).toBe(contents);
    fs.closeSync(arrivals[0].fds[0]);

    // The caller keeps its own descriptor: we duped, so this one is still
    // open and still ours to close. (Reading it again would come up empty --
    // SCM_RIGHTS shares the open file description, offset included, so the
    // peer's read above moved this one too.)
    expect(() => fs.fstatSync(fd)).not.toThrow();
    fs.closeSync(fd);
  });

  it('carries several at once', async () => {
    const { stream, peer } = pair('send-many');
    const a = payload('one\n');
    const b = payload('two\n');
    const c = payload('three\n');

    stream.writeWithFds(Buffer.from('three-of-them'), [a.fd, b.fd, c.fd]);

    const arrivals = await peer.readUntilFds();
    expect(arrivals[0].fds).toHaveLength(3);
    const seen = arrivals[0].fds.map(f => {
      const text = fs.readFileSync(f, 'utf8');
      fs.closeSync(f);
      return text;
    });
    // Order is the order they were sent in, which is what lets a message take
    // its share by count.
    expect(seen).toEqual(['one\n', 'two\n', 'three\n']);
    [a, b, c].forEach(p => fs.closeSync(p.fd));
  });

  it('never lets descriptors overtake the bytes written before them', async () => {
    const { stream, peer } = pair('order');
    const { fd } = payload('after-a-megabyte\n');
    const bulk = Buffer.alloc(1024 * 1024, 0x61);

    // A megabyte does not fit in a socket buffer, so this backs up and the
    // rest of it goes out as the peer drains -- while the fd write waits its
    // turn behind it. Ancillary data attaches to the byte it is sent with, so
    // a descriptor that jumped the queue would arrive against someone else's
    // message.
    stream.write(bulk);
    stream.writeWithFds(Buffer.from('!'), [fd]);

    await peer.readAtLeast(bulk.length + 1);
    const arrivals = await peer.readUntilFds();
    expect(peer.bytes.length).toBe(bulk.length + 1);
    expect(arrivals).toHaveLength(1);

    // Early is allowed; late is not. Linux glues queued messages into one
    // recvmsg and hands over the descriptors of the first one that carries
    // any, so they can be reported against bytes that precede their own
    // message -- measured at 48000 bytes early on CI. macOS stops at the
    // message boundary and reports them exactly. Either way a descriptor is
    // never delivered after the bytes it belongs to, which is what makes a
    // queue popped by the message that declares them correct on both.
    expect(arrivals[0].offset).toBeLessThanOrEqual(bulk.length);
    if (process.platform === 'darwin') {
      expect(arrivals[0].offset).toBe(bulk.length);
    }
    expect(peer.bytes.subarray(0, bulk.length).equals(bulk)).toBe(true);
    expect(peer.bytes[bulk.length]).toBe(0x21);

    fs.closeSync(arrivals[0].fds[0]);
    fs.closeSync(fd);
  });

  it('refuses more descriptors than a message may carry', () => {
    const { stream } = pair('too-many');
    const { fd } = payload('x');
    expect(() =>
      stream.writeWithFds(
        Buffer.from('x'),
        new Array(transport.MAX_FDS + 1).fill(fd)
      )
    ).toThrow(/at most \d+ file descriptors/);
    fs.closeSync(fd);
  });
});

describe('receiving descriptors', () => {
  it('emits them before the bytes that claim them are readable', async () => {
    const { stream, peer } = pair('receive');
    const { fd, contents } = payload('received-through-the-socket\n');

    const order = [];
    let received = null;
    stream.on('fds', fds => {
      order.push('fds');
      received = fds;
    });
    stream.on('readable', () => order.push('readable'));

    peer.send(Buffer.from('carrier'), [fd]);
    fs.closeSync(fd); // the peer's own copy; ours arrives independently

    while (received === null) await sleep(5);
    // The parser takes descriptors while reading a header, so they have to be
    // queued by the time any of that message is readable.
    expect(order[0]).toBe('fds');
    expect(order).toContain('readable');
    expect(stream.read(7).toString()).toBe('carrier');
    expect(fs.readFileSync(received[0], 'utf8')).toBe(contents);
    fs.closeSync(received[0]);
  });

  it('hands over what arrived, in arrival order', async () => {
    const { stream, peer } = pair('receive-many');
    const a = payload('first\n');
    const b = payload('second\n');

    const received = [];
    stream.on('fds', fds => received.push(...fds));
    stream.on('readable', () => stream.read());

    peer.send(Buffer.from('one'), [a.fd]);
    peer.send(Buffer.from('two'), [b.fd]);
    fs.closeSync(a.fd);
    fs.closeSync(b.fd);

    while (received.length < 2) await sleep(5);
    const texts = received.map(f => {
      const text = fs.readFileSync(f, 'utf8');
      fs.closeSync(f);
      return text;
    });
    expect(texts).toEqual(['first\n', 'second\n']);
  });

  it('closes descriptors nobody claimed, on request', async () => {
    const { stream, peer } = pair('orphan');
    const { fd } = payload('orphaned\n');

    const received = [];
    stream.on('fds', fds => received.push(...fds));
    peer.send(Buffer.from('x'), [fd]);
    fs.closeSync(fd);
    while (received.length === 0) await sleep(5);

    // What index.js does on 'close' for descriptors no message ever took.
    const orphan = received[0];
    expect(() => fs.fstatSync(orphan)).not.toThrow();
    stream.closeFds([orphan]);
    expect(() => fs.fstatSync(orphan)).toThrow();
  });
});

describe('the stream underneath', () => {
  it('reads a byte stream like any other socket', async () => {
    const { stream, peer } = pair('bytes');
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    peer.send(Buffer.from('hello '), []);
    peer.send(Buffer.from('world'), []);
    while (Buffer.concat(chunks).length < 11) await sleep(5);
    expect(Buffer.concat(chunks).toString()).toBe('hello world');
  });

  it('writes more than a socket buffer holds, in order', async () => {
    const { stream, peer } = pair('backpressure');
    const bulk = Buffer.alloc(512 * 1024);
    for (let i = 0; i < bulk.length; i++) bulk[i] = i & 0xff;

    const backpressured = !stream.write(bulk);
    await peer.readAtLeast(bulk.length);
    expect(peer.bytes.equals(bulk)).toBe(true);
    // Not an assertion about the exact high-water mark -- just that a write
    // this size is reported one way or the other and still arrives whole.
    expect(typeof backpressured).toBe('boolean');
  });

  it('ends the stream when the peer goes away', async () => {
    const { stream, peer } = pair('eof');
    let ended = false;
    stream.on('end', () => {
      ended = true;
    });
    stream.resume();
    peer.close();
    for (let i = 0; i < 200 && !ended; i++) await sleep(5);
    expect(ended).toBe(true);
  });

  it('stops the reader thread when destroyed', async () => {
    const peer = listenAt(socketPath('teardown'));
    const stream = transport.connect({ path: peer.path });
    peer.accept();
    let closed = false;
    stream.on('close', () => {
      closed = true;
    });
    stream.destroy();
    for (let i = 0; i < 200 && !closed; i++) await sleep(5);
    expect(closed).toBe(true);
    peer.close();
  });
});

// Linux-only, and the one address shape whose sockaddr differs: the name goes
// after a leading NUL and the length passed to connect(2) has to be exactly
// what the name needs -- pass the whole struct and the trailing NULs are part
// of the name, so it is a different socket and nothing is listening on it.
describe.skipIf(process.platform !== 'linux')('abstract addresses', () => {
  it('connects to one, and carries a descriptor over it', async () => {
    const name = `dbus-native-fd-test-${process.pid}`;
    const { stream, peer } = pair(null, { abstract: name });
    const { fd, contents } = payload('over-an-abstract-socket\n');

    stream.writeWithFds(Buffer.from('carrier'), [fd]);
    const arrivals = await peer.readUntilFds();
    expect(peer.bytes.toString()).toBe('carrier');
    expect(fs.readFileSync(arrivals[0].fds[0], 'utf8')).toBe(contents);
    fs.closeSync(arrivals[0].fds[0]);
    fs.closeSync(fd);
  });
});

describe('when it cannot be used', () => {
  it('says so rather than throwing, for a path that is too long', () => {
    const tooLong = `/tmp/${'x'.repeat(200)}.sock`;
    expect(transport.connect({ path: tooLong })).toBe(null);
  });

  it('says so rather than throwing, for a socket nobody is listening on', () => {
    expect(transport.connect({ path: '/tmp/definitely-not-there.sock' })).toBe(
      null
    );
  });
});
