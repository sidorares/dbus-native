// The other end of a unix socket, with its own hand-rolled SCM_RIGHTS.
//
// Deliberately a second implementation of the same struct layouts rather than
// a reuse of lib/transport-bun.js: a mistake in msghdr/cmsghdr offsets that
// both ends made identically would cancel itself out and the tests would pass
// on a wire format nothing else can read. Written from cmsg(3) and unix(7).

const { dlopen, ptr, read } = require('bun:ffi');

const isDarwin = process.platform === 'darwin';

const lib = dlopen(
  isDarwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
  Object.assign(
    {
      socket: { args: ['int', 'int', 'int'], returns: 'int' },
      bind: { args: ['int', 'ptr', 'int'], returns: 'int' },
      listen: { args: ['int', 'int'], returns: 'int' },
      accept: { args: ['int', 'ptr', 'ptr'], returns: 'int' },
      sendmsg: { args: ['int', 'ptr', 'int'], returns: 'i64' },
      recvmsg: { args: ['int', 'ptr', 'int'], returns: 'i64' },
      close: { args: ['int'], returns: 'int' }
    },
    isDarwin
      ? { __error: { args: [], returns: 'ptr' } }
      : { __errno_location: { args: [], returns: 'ptr' } }
  )
);

const sym = lib.symbols;
const errnoAt = isDarwin ? sym.__error : sym.__errno_location;
const errno = () => read.i32(errnoAt(), 0);

const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SOL_SOCKET = isDarwin ? 0xffff : 1;
const SCM_RIGHTS = 1;
const MSG_DONTWAIT = isDarwin ? 0x80 : 0x40;
const EAGAIN = isDarwin ? 35 : 11;

// cmsghdr is { socklen_t len; int level; int type; } on macOS and
// { size_t len; int level; int type; } on Linux, and its payload aligns to the
// width of that first field.
const HDR = isDarwin ? 12 : 16;
const align = n => (isDarwin ? (n + 3) & ~3 : (n + 7) & ~7);

/**
 * `{ path }` or `{ abstract }`, and the length to pass with it.
 *
 * An abstract name lives in sun_path with a leading NUL and is exactly as long
 * as the address says -- pass the whole struct and every trailing NUL becomes
 * part of the name, which is a different socket.
 */
function sockaddr(target) {
  const sa = Buffer.alloc(2 + (isDarwin ? 104 : 108));
  if (isDarwin) {
    sa.writeUInt8(sa.length, 0);
    sa.writeUInt8(AF_UNIX, 1);
  } else {
    sa.writeUInt16LE(AF_UNIX, 0);
  }
  if (target.abstract === undefined) {
    sa.write(target.path, 2);
    return { sa, len: sa.length };
  }
  sa.write(target.abstract, 3);
  return { sa, len: 2 + 1 + Buffer.byteLength(target.abstract) };
}

/** A msghdr pointing at one iovec and one control buffer. */
function msghdr(iov, ctl, ctlLen) {
  const msg = Buffer.alloc(56);
  msg.writeBigUInt64LE(BigInt(ptr(iov)), 16);
  if (isDarwin) msg.writeInt32LE(1, 24);
  else msg.writeBigUInt64LE(1n, 24);
  if (ctlLen > 0) {
    msg.writeBigUInt64LE(BigInt(ptr(ctl)), 32);
    if (isDarwin) msg.writeUInt32LE(ctlLen, 40);
    else msg.writeBigUInt64LE(BigInt(ctlLen), 40);
  }
  return msg;
}

function iovec(buf) {
  const iov = Buffer.alloc(16);
  iov.writeBigUInt64LE(BigInt(ptr(buf)), 0);
  iov.writeBigUInt64LE(BigInt(buf.length), 8);
  return iov;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Peer {
  constructor(listenFd, target) {
    this._listen = listenFd;
    this._fd = -1;
    this.target = target;
    this.path = target.path;
    /** Everything read so far. */
    this.bytes = Buffer.alloc(0);
    /** Where descriptors turned up: { offset, fds }, in arrival order. */
    this.arrivals = [];
  }

  accept() {
    this._fd = sym.accept(this._listen, null, null);
    if (this._fd < 0) throw new Error(`accept failed (errno ${errno()})`);
    return this;
  }

  /** Send `buf` with `fds` attached, the way a peer that passes fds does. */
  send(buf, fds) {
    const iov = iovec(buf);
    const payload = 4 * fds.length;
    const ctlLen = align(HDR) + align(payload);
    const ctl = Buffer.alloc(ctlLen);
    if (isDarwin) ctl.writeUInt32LE(HDR + payload, 0);
    else ctl.writeBigUInt64LE(BigInt(HDR + payload), 0);
    ctl.writeInt32LE(SOL_SOCKET, isDarwin ? 4 : 8);
    ctl.writeInt32LE(SCM_RIGHTS, isDarwin ? 8 : 12);
    fds.forEach((fd, i) => ctl.writeInt32LE(fd, HDR + 4 * i));
    const msg = msghdr(iov, ctl, ctlLen);
    const sent = Number(sym.sendmsg(this._fd, ptr(msg), 0));
    if (sent !== buf.length) {
      throw new Error(`sendmsg sent ${sent} of ${buf.length}`);
    }
    return sent;
  }

  /** One non-blocking recvmsg. Returns the byte count, or -1 for "nothing". */
  poll() {
    const data = Buffer.alloc(65536);
    const ctl = Buffer.alloc(align(HDR) + align(4 * 64));
    const iov = iovec(data);
    const msg = msghdr(iov, ctl, ctl.length);
    const n = Number(sym.recvmsg(this._fd, ptr(msg), MSG_DONTWAIT));
    if (n < 0) {
      if (errno() === EAGAIN) return -1;
      throw new Error(`recvmsg failed (errno ${errno()})`);
    }
    const controlLen = isDarwin
      ? msg.readUInt32LE(40)
      : Number(msg.readBigUInt64LE(40));
    const fds = [];
    let off = 0;
    while (off + HDR <= controlLen) {
      const len = isDarwin
        ? ctl.readUInt32LE(off)
        : Number(ctl.readBigUInt64LE(off));
      if (len < HDR) break;
      if (
        ctl.readInt32LE(off + (isDarwin ? 4 : 8)) === SOL_SOCKET &&
        ctl.readInt32LE(off + (isDarwin ? 8 : 12)) === SCM_RIGHTS
      ) {
        for (let p = off + HDR; p + 4 <= off + len; p += 4) {
          fds.push(ctl.readInt32LE(p));
        }
      }
      off += align(len);
    }
    if (fds.length > 0) {
      this.arrivals.push({ offset: this.bytes.length, fds });
    }
    if (n > 0) this.bytes = Buffer.concat([this.bytes, data.subarray(0, n)]);
    return n;
  }

  /** Read until at least `count` bytes have arrived, or time out. */
  async readAtLeast(count, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (this.bytes.length < count) {
      if (this.poll() === 0) break; // end of stream
      if (this.bytes.length >= count) break;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out with ${this.bytes.length} of ${count} bytes read`
        );
      }
      await sleep(1);
    }
    return this.bytes;
  }

  /** Read until descriptors have turned up, or time out. */
  async readUntilFds(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (this.arrivals.length === 0) {
      if (this.poll() === 0) break;
      if (Date.now() > deadline) throw new Error('timed out waiting for fds');
      await sleep(1);
    }
    return this.arrivals;
  }

  close() {
    if (this._fd >= 0) sym.close(this._fd);
    if (this._listen >= 0) sym.close(this._listen);
    this._fd = this._listen = -1;
    if (this.path !== undefined) {
      try {
        require('fs').unlinkSync(this.path);
      } catch {}
    }
  }
}

/** Bind and listen on `{ path }` or `{ abstract }`, ready for one connection. */
function listenAt(target) {
  const where = typeof target === 'string' ? { path: target } : target;
  const fd = sym.socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) throw new Error(`socket failed (errno ${errno()})`);
  const address = sockaddr(where);
  if (sym.bind(fd, ptr(address.sa), address.len) !== 0) {
    const e = errno();
    sym.close(fd);
    throw new Error(`bind failed (errno ${e})`);
  }
  if (sym.listen(fd, 4) !== 0) {
    const e = errno();
    sym.close(fd);
    throw new Error(`listen failed (errno ${e})`);
  }
  return new Peer(fd, where);
}

module.exports = { listenAt, sleep };
