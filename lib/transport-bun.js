// A unix-socket transport that can carry file descriptors, for Bun.
//
// ROADMAP 2.8 measured every way of doing this on Node and found none: there
// is no ancillary-data API, nodejs/node#53391 is closed as not planned, and
// every addon that works needs a compiler on every install -- which is the
// property several releases were spent acquiring. So the capability was left
// as a seam on the stream (`writeWithFds`, an `'fds'` event) and nothing here
// filled it.
//
// Bun fills it with no dependency and no build step: `bun:ffi` can call
// sendmsg(2)/recvmsg(2) directly. `dlopen`, not bun:ffi's `cc()` -- cc() would
// make the CMSG_* macros free but compiles against the system libc and headers
// at runtime, which a slim container need not have. Plain dlopen needs only
// hand-built msghdr/cmsghdr bytes, which are small, fixed, and differ between
// Linux and macOS in exactly two ways (see "wire structs").
//
// This transport OWNS the connection descriptor, because receiving is the half
// that matters here and Bun's socket reader does a plain read(2), which
// silently drops ancillary data. That is fatal for d-bus in a way it is not
// for a protocol where descriptors only arrive if you ask: negotiation is
// per-connection, so once NEGOTIATE_UNIX_FD is agreed, *any* peer may put a
// descriptor in *any* reply -- and a message whose UNIX_FDS header says 1 when
// none arrived is a protocol error that takes the connection down
// (lib/message.js). Send-only would be a connection that dies the first time
// something hands us a descriptor, so this is send *and* receive or nothing.
//
// Reading therefore happens on a worker thread blocked in poll(2), which is
// what Bun's event loop cannot be asked to do for a descriptor it does not
// own. The thread does the recvmsg too and posts { bytes, fds }: d-bus message
// rates are low, descriptors are plain ints and valid process-wide, and it
// keeps the re-arm protocol to one byte in each direction.
//
// Ownership, both directions:
//   - descriptors given to writeWithFds() are DUPed here and the caller keeps
//     its own, exactly as libdbus does. A queued write may be sent a tick
//     later, so a caller that closed its descriptor on return would otherwise
//     send a stale number;
//   - descriptors that arrive are handed over by the 'fds' event and are the
//     receiver's from then on. Anything that arrived but was never claimed by
//     a message is closed by closeFds() when the connection goes away.

const { Duplex } = require('stream');

// require() behind an indirection: `bun:ffi` and the worker exist only on the
// runtime that uses them, and a bundler must neither resolve nor inline them.
// A computed specifier is not enough on its own -- esbuild folds `'bun' +
// ':ffi'` straight back into a literal -- so the call is what hides it.
const nodeRequire = require;
const loadModule = name => nodeRequire(name);

const isDarwin = process.platform === 'darwin';
const supportedPlatform = isDarwin || process.platform === 'linux';

const LIBC_CANDIDATES = isDarwin
  ? ['/usr/lib/libSystem.B.dylib']
  : ['libc.so.6', 'libc.so', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1'];

// Only non-variadic entry points. fcntl(2) and ioctl(2) are variadic, and a
// variadic call made through a fixed FFI signature passes its arguments in the
// wrong place on arm64 -- nothing here needs them, because MSG_DONTWAIT makes
// every send and receive non-blocking per call rather than per descriptor.
const SYMBOLS = {
  socket: { args: ['int', 'int', 'int'], returns: 'int' },
  connect: { args: ['int', 'ptr', 'int'], returns: 'int' },
  setsockopt: {
    args: ['int', 'int', 'int', 'ptr', 'int'],
    returns: 'int'
  },
  sendmsg: { args: ['int', 'ptr', 'int'], returns: 'i64' },
  send: { args: ['int', 'ptr', 'u64', 'int'], returns: 'i64' },
  write: { args: ['int', 'ptr', 'u64'], returns: 'i64' },
  shutdown: { args: ['int', 'int'], returns: 'int' },
  dup: { args: ['int'], returns: 'int' },
  pipe: { args: ['ptr'], returns: 'int' },
  close: { args: ['int'], returns: 'int' }
};

const ERRNO_SYMBOL = isDarwin
  ? { __error: { args: [], returns: 'ptr' } }
  : { __errno_location: { args: [], returns: 'ptr' } };

let libc = null;
let libcProbed = false;

function loadLibc() {
  if (libcProbed) return libc;
  libcProbed = true;
  if (typeof Bun === 'undefined' || !supportedPlatform) return null;
  let ffi;
  try {
    ffi = loadModule('bun:ffi');
  } catch {
    return null;
  }
  for (const name of LIBC_CANDIDATES) {
    let lib;
    try {
      lib = ffi.dlopen(name, { ...SYMBOLS, ...ERRNO_SYMBOL });
    } catch {
      continue; // not this libc -- try the next candidate
    }
    const errnoLocation = isDarwin
      ? lib.symbols.__error
      : lib.symbols.__errno_location;
    libc = {
      name,
      sym: lib.symbols,
      ptr: ffi.ptr,
      errno: () => ffi.read.i32(errnoLocation(), 0)
    };
    break;
  }
  return libc;
}

// ---------------------------------------------------------------------------
// wire structs
//
// Both platforms are LP64, and struct msghdr is 56 bytes on both, but:
//
//   struct msghdr   msg_iovlen / msg_controllen are `int` + padding on macOS
//                   and `size_t` on Linux
//   struct cmsghdr  { len; int level; int type; } -- len is socklen_t (4) on
//                   macOS and size_t (8) on Linux, so the header is 12 vs 16
//                   bytes and the payload after it aligns to 4 vs 8
//   struct iovec    { void *base; size_t len; } -- 16 bytes on both
// ---------------------------------------------------------------------------

const MSGHDR_SIZE = 56;
const OFF_IOV = 16;
const OFF_IOVLEN = 24;
const OFF_CONTROL = 32;
const OFF_CONTROLLEN = 40;

const CMSG_HDR = isDarwin ? 12 : 16;
const cmsgAlign = n => (isDarwin ? (n + 3) & ~3 : (n + 7) & ~7);
const OFF_CMSG_LEVEL = isDarwin ? 4 : 8;
const OFF_CMSG_TYPE = isDarwin ? 8 : 12;

const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SHUT_WR = 1;
const SOL_SOCKET = isDarwin ? 0xffff : 1;
const SCM_RIGHTS = 1;
const MSG_DONTWAIT = isDarwin ? 0x80 : 0x40;
// macOS only, and the reason they are needed at all is worth stating: Darwin
// does NOT honour MSG_DONTWAIT for AF_UNIX -- a send larger than the socket
// buffer blocks the calling thread, which for us is the event loop. The usual
// fix, O_NONBLOCK through fcntl(2), is not available: fcntl is variadic, and a
// variadic function called through a fixed FFI signature takes its third
// argument from the wrong place on arm64. Measured, not assumed: F_SETFL
// returns 0 and F_GETFL then shows the flag was never set.
//
// setsockopt(2) is not variadic, and a send timeout bounds the block instead:
// BSD turns a timed-out send that moved some bytes into a short write, and one
// that moved none into EWOULDBLOCK -- which is exactly the contract the flush
// loop already handles. The receive side gets one too, so that a spurious poll
// wakeup can never wedge the reader thread.
const SO_SNDTIMEO = 0x1005;
const SO_RCVTIMEO = 0x1006;
const SEND_TIMEOUT_US = 2000;
const EINTR = 4;
const EAGAIN = isDarwin ? 35 : 11; // == EWOULDBLOCK on both
const EMSGSIZE = isDarwin ? 40 : 90;
const SUN_PATH_MAX = isDarwin ? 104 : 108;

// Descriptors per message. dbus-daemon enforces its own limit
// (`max_message_unix_fds`, 16 in the reference configuration), so this is a
// backstop against a peer that claims more than a control buffer we are
// willing to keep as a scratch allocation -- not a policy of our own.
const MAX_FDS = 64;
const READ_SIZE = 65536;

// Scratch, reused for every call: libc is handed pointers into these, so they
// must not move or be collected mid-call. Every use is synchronous and on the
// main thread, so one set is enough.
const msgScratch = Buffer.alloc(MSGHDR_SIZE);
const iovScratch = Buffer.alloc(16);
const ctlScratch = Buffer.alloc(cmsgAlign(CMSG_HDR) + cmsgAlign(4 * MAX_FDS));

function setMsghdr(iovPtr, ctlPtr, ctlLen) {
  msgScratch.fill(0);
  msgScratch.writeBigUInt64LE(BigInt(iovPtr), OFF_IOV);
  if (isDarwin) msgScratch.writeInt32LE(1, OFF_IOVLEN);
  else msgScratch.writeBigUInt64LE(1n, OFF_IOVLEN);
  if (ctlLen > 0) {
    msgScratch.writeBigUInt64LE(BigInt(ctlPtr), OFF_CONTROL);
    if (isDarwin) msgScratch.writeUInt32LE(ctlLen, OFF_CONTROLLEN);
    else msgScratch.writeBigUInt64LE(BigInt(ctlLen), OFF_CONTROLLEN);
  }
}

function setIovec(buf) {
  iovScratch.writeBigUInt64LE(BigInt(libc.ptr(buf)), 0);
  iovScratch.writeBigUInt64LE(BigInt(buf.length), 8);
}

/**
 * Send `buf` with `fds` attached as SCM_RIGHTS ancillary data.
 *
 * Returns the number of bytes the kernel took -- which may be fewer than
 * offered, in which case the descriptors went with the bytes it did take --
 * or -1 with errno set.
 */
function sendmsgWithFds(fd, buf, fds) {
  setIovec(buf);
  const payload = 4 * fds.length;
  const ctlLen = cmsgAlign(CMSG_HDR) + cmsgAlign(payload);
  ctlScratch.fill(0, 0, ctlLen);
  if (isDarwin) ctlScratch.writeUInt32LE(CMSG_HDR + payload, 0);
  else ctlScratch.writeBigUInt64LE(BigInt(CMSG_HDR + payload), 0);
  ctlScratch.writeInt32LE(SOL_SOCKET, OFF_CMSG_LEVEL);
  ctlScratch.writeInt32LE(SCM_RIGHTS, OFF_CMSG_TYPE);
  for (let i = 0; i < fds.length; i++) {
    ctlScratch.writeInt32LE(fds[i], CMSG_HDR + 4 * i);
  }
  setMsghdr(libc.ptr(iovScratch), libc.ptr(ctlScratch), ctlLen);
  return Number(libc.sym.sendmsg(fd, libc.ptr(msgScratch), MSG_DONTWAIT));
}

/**
 * Bound how long a send or receive may block. macOS only -- see SO_SNDTIMEO.
 *
 * Returns false if either could not be set, which makes the descriptor unsafe
 * to drive from the event loop and so unusable to us.
 */
function boundBlocking(fd) {
  if (!isDarwin) return true;
  const tv = Buffer.alloc(16); // struct timeval { time_t sec; suseconds_t usec }
  tv.writeInt32LE(SEND_TIMEOUT_US, 8);
  for (const option of [SO_SNDTIMEO, SO_RCVTIMEO]) {
    const rc = libc.sym.setsockopt(
      fd,
      SOL_SOCKET,
      option,
      libc.ptr(tv),
      tv.length
    );
    if (rc !== 0) return false;
  }
  return true;
}

function sendPlain(fd, buf) {
  return Number(
    libc.sym.send(fd, libc.ptr(buf), BigInt(buf.length), MSG_DONTWAIT)
  );
}

function closeFds(fds) {
  for (const fd of fds) {
    if (typeof fd === 'number' && fd >= 0) libc.sym.close(fd);
  }
}

/**
 * sockaddr_un, and the exact length to pass with it.
 *
 * `{ u8 len; u8 family; char path[104] }` on macOS, `{ u16 family; char
 * path[108] }` on Linux. An abstract address is Linux-only and starts with a
 * NUL: the name is whatever follows, so the length must be exactly what the
 * name needs -- pass the whole struct and the trailing NULs become part of the
 * name, which is a different socket from the one the address meant.
 */
function sockaddrUn(target) {
  const name = target.abstract === undefined ? target.path : target.abstract;
  const bytes = Buffer.byteLength(name);
  if (bytes >= SUN_PATH_MAX) return null;
  const sa = Buffer.alloc(2 + SUN_PATH_MAX);
  if (isDarwin) {
    sa.writeUInt8(sa.length, 0);
    sa.writeUInt8(AF_UNIX, 1);
  } else {
    sa.writeUInt16LE(AF_UNIX, 0);
  }
  if (target.abstract === undefined) {
    sa.write(name, 2);
    return { sa, len: sa.length };
  }
  sa.write(name, 3); // sun_path[0] stays NUL: that is what makes it abstract
  return { sa, len: 2 + 1 + bytes };
}

// ---------------------------------------------------------------------------
// the reader thread
//
// It blocks in poll(2) and does the recvmsg, posting { bytes, fds } to the
// main thread. Main -> worker is a single byte on a pipe, which the poll wakes
// on immediately:
//
//   'r'  the main thread has taken the last chunk: watch for readable again
//   'o'  watch for writable  /  'p' stop watching for writable
//   's'  stop: close what this thread owns and exit
//
// The thread holds its own dup() of the connection, so a descriptor number
// reused after close() can never be polled by mistake, and the connection
// stays open until the thread has actually gone.
// ---------------------------------------------------------------------------

const POLLER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('worker_threads');
const ffi = require('bun' + ':ffi');
const isDarwin = process.platform === 'darwin';
const lib = ffi.dlopen(workerData.libc, {
    // nfds_t is unsigned long on Linux and unsigned int on macOS. Declaring
    // it 64-bit is right on one and harmless on the other -- the callee reads
    // the low half -- whereas a 32-bit argument in a 64-bit slot leaves the
    // top half to chance.
    poll:    { args: ['ptr', 'u64', 'int'], returns: 'int' },
    recvmsg: { args: ['int', 'ptr', 'int'], returns: 'i64' },
    read:    { args: ['int', 'ptr', 'u64'], returns: 'i64' },
    close:   { args: ['int'], returns: 'int' },
    ...(isDarwin
        ? { __error: { args: [], returns: 'ptr' } }
        : { __errno_location: { args: [], returns: 'ptr' } })
});
const sym = lib.symbols;
const errnoLocation = isDarwin ? sym.__error : sym.__errno_location;
const errno = () => ffi.read.i32(errnoLocation(), 0);

const CMSG_HDR = isDarwin ? 12 : 16;
const cmsgAlign = n => (isDarwin ? (n + 3) & ~3 : (n + 7) & ~7);
const OFF_CMSG_LEVEL = isDarwin ? 4 : 8;
const OFF_CMSG_TYPE = isDarwin ? 8 : 12;
const SOL_SOCKET = isDarwin ? 0xffff : 1;
const MSG_DONTWAIT = isDarwin ? 0x80 : 0x40;
const MSG_CTRUNC = isDarwin ? 0x20 : 0x08;
// Received descriptors must not survive an exec: a d-bus client that spawns a
// child (a portal caller does this constantly) would otherwise hand the peer's
// descriptors to it. Linux has the flag; macOS has no equivalent for recvmsg.
const MSG_CMSG_CLOEXEC = isDarwin ? 0 : 0x40000000;
const EINTR = 4;
const EAGAIN = isDarwin ? 35 : 11;
const POLLIN = 1, POLLOUT = 4, POLLERR = 8, POLLHUP = 16, POLLNVAL = 32;

const sock = workerData.sock, wake = workerData.wake;
const maxFds = workerData.maxFds, readSize = workerData.readSize;

const msg = Buffer.alloc(56);
const iov = Buffer.alloc(16);
const ctl = Buffer.alloc(cmsgAlign(CMSG_HDR) + cmsgAlign(4 * maxFds));
const data = Buffer.allocUnsafeSlow(readSize);
const pollfds = Buffer.alloc(16); // two struct pollfd { int fd; short ev, rev; }
const commands = Buffer.alloc(64);

function receive() {
    iov.writeBigUInt64LE(BigInt(ffi.ptr(data)), 0);
    iov.writeBigUInt64LE(BigInt(data.length), 8);
    ctl.fill(0);
    msg.fill(0);
    msg.writeBigUInt64LE(BigInt(ffi.ptr(iov)), 16);
    if (isDarwin) msg.writeInt32LE(1, 24);
    else msg.writeBigUInt64LE(1n, 24);
    msg.writeBigUInt64LE(BigInt(ffi.ptr(ctl)), 32);
    if (isDarwin) msg.writeUInt32LE(ctl.length, 40);
    else msg.writeBigUInt64LE(BigInt(ctl.length), 40);
    const n = Number(sym.recvmsg(sock, ffi.ptr(msg), MSG_DONTWAIT | MSG_CMSG_CLOEXEC));
    if (n <= 0) return { n, fds: null, truncated: false };
    const controlLen = isDarwin
        ? msg.readUInt32LE(40)
        : Number(msg.readBigUInt64LE(40));
    const truncated = (msg.readInt32LE(48) & MSG_CTRUNC) !== 0;
    let fds = null;
    let off = 0;
    while (off + CMSG_HDR <= controlLen) {
        const len = isDarwin
            ? ctl.readUInt32LE(off)
            : Number(ctl.readBigUInt64LE(off));
        if (len < CMSG_HDR) break;
        if (ctl.readInt32LE(off + OFF_CMSG_LEVEL) === SOL_SOCKET &&
            ctl.readInt32LE(off + OFF_CMSG_TYPE) === 1) {
            fds = fds || [];
            for (let p = off + CMSG_HDR; p + 4 <= off + len; p += 4)
                fds.push(ctl.readInt32LE(p));
        }
        off += cmsgAlign(len);
    }
    return { n, fds, truncated };
}

let watchRead = true, watchWrite = false, running = true, failures = 0;
while (running) {
    pollfds.writeInt32LE(sock, 0);
    pollfds.writeInt16LE((watchRead ? POLLIN : 0) | (watchWrite ? POLLOUT : 0), 4);
    pollfds.writeInt16LE(0, 6);
    pollfds.writeInt32LE(wake, 8);
    pollfds.writeInt16LE(POLLIN, 12);
    pollfds.writeInt16LE(0, 14);
    const rc = sym.poll(ffi.ptr(pollfds), 2n, -1);
    if (rc < 0) {
        // EINTR: retry. A descriptor that has really gone bad shows up as
        // POLLNVAL below instead, so a poll that keeps failing is something
        // this thread cannot fix -- say so rather than spin.
        if (errno() === EINTR && ++failures < 64) continue;
        parentPort.postMessage({ type: 'error', message: 'waiting on the connection failed (errno ' + errno() + ')' });
        break;
    }
    failures = 0;
    if (pollfds.readInt16LE(14)) {
        const n = Number(sym.read(wake, ffi.ptr(commands), 64n));
        for (let i = 0; i < n; i++) {
            const c = commands[i];
            if (c === 115) running = false;         // 's'
            else if (c === 114) watchRead = true;   // 'r'
            else if (c === 111) watchWrite = true;  // 'o'
            else if (c === 112) watchWrite = false; // 'p'
        }
        if (!running) break;
    }
    const revents = pollfds.readInt16LE(6);
    if (revents & POLLNVAL) {
        parentPort.postMessage({ type: 'error', message: 'the connection descriptor became invalid' });
        break;
    }
    if (revents & POLLOUT) {
        watchWrite = false;
        parentPort.postMessage({ type: 'writable' });
    }
    if (!(revents & (POLLIN | POLLHUP | POLLERR))) continue;
    const { n, fds, truncated } = receive();
    if (truncated) {
        if (fds) for (const fd of fds) sym.close(fd);
        parentPort.postMessage({ type: 'error', message: 'descriptors were dropped: the control message was truncated' });
        break;
    }
    if (n > 0) {
        const out = new Uint8Array(n);
        out.set(data.subarray(0, n));
        // Level-triggered, so stop watching until the main thread says it has
        // taken this chunk -- otherwise the poll returns immediately forever.
        watchRead = false;
        parentPort.postMessage({ type: 'data', data: out, fds: fds || null }, [out.buffer]);
        continue;
    }
    if (n === 0) {
        parentPort.postMessage({ type: 'eof' });
        break;
    }
    const e = errno();
    if (e === EAGAIN || e === EINTR) {
        // Nothing there after all. With the peer gone that is the end of the
        // stream rather than "not yet", and re-arming would spin.
        if (revents & (POLLHUP | POLLERR)) {
            parentPort.postMessage({ type: 'eof' });
            break;
        }
        continue;
    }
    parentPort.postMessage({ type: 'error', message: 'reading from the connection failed (errno ' + e + ')' });
    break;
}
sym.close(sock);
sym.close(wake);
`;

// ---------------------------------------------------------------------------
// the stream
// ---------------------------------------------------------------------------

/**
 * A Duplex over a connected unix socket we own, plus `writeWithFds()` and an
 * `'fds'` event -- the seam documented in docs/api.md.
 *
 * Being a real Duplex is not cosmetic: `unmarshalMessages()` frames messages
 * with `stream.read(n)` on `'readable'`, the handshake reads lines the same
 * way, and `connection.message()` batches with cork/uncork. All of that comes
 * from the base class, which leaves this file with only the syscalls.
 */
class BunUnixSocket extends Duplex {
  constructor(fd) {
    super();
    this._fd = fd;
    this._wake = -1;
    this._worker = null;
    // Writes not yet taken by the kernel, in wire order: { buf, off, fds, cb }.
    this._backlog = [];
    // Descriptors tagged onto a chunk by writeWithFds(), matched back to it by
    // identity in _writev() -- so they attach to their own message's bytes and
    // to nothing else.
    this._tagged = [];
    this._watchingWrite = false;
    this._readPaused = false;
    this._flushing = false;
    this._finalCb = null;
    this._failure = null;
  }

  // ---- reading ------------------------------------------------------------

  _startReader() {
    const { Worker } = loadModule('worker_threads');
    const pipefds = new Int32Array(2);
    if (libc.sym.pipe(libc.ptr(pipefds)) !== 0) {
      throw new Error(
        `could not create the reader wake pipe (errno ${libc.errno()})`
      );
    }
    const dup = libc.sym.dup(this._fd);
    if (dup < 0) {
      const err = libc.errno();
      libc.sym.close(pipefds[0]);
      libc.sym.close(pipefds[1]);
      throw new Error(
        `could not duplicate the connection descriptor (errno ${err})`
      );
    }
    this._wake = pipefds[1];
    try {
      // The worker source is inlined rather than kept in a sibling file so
      // that a bundled application still has it.
      this._worker = new Worker(POLLER_SOURCE, {
        eval: true,
        workerData: {
          libc: libc.name,
          sock: dup,
          wake: pipefds[0],
          maxFds: MAX_FDS,
          readSize: READ_SIZE
        }
      });
    } catch (err) {
      libc.sym.close(dup); // nothing owns these yet
      libc.sym.close(pipefds[0]);
      libc.sym.close(pipefds[1]);
      this._wake = -1;
      throw err;
    }
    this._worker.on('message', msg => this._onWorkerMessage(msg));
    this._worker.on('error', err => this._fail(err));
    // A thread blocked in poll() keeps the process alive, which is what an
    // open connection should do. destroy() stops it.
  }

  _tell(command) {
    if (this._wake < 0) return;
    const byte = Buffer.from(command);
    libc.sym.write(this._wake, libc.ptr(byte), 1n);
  }

  _onWorkerMessage(msg) {
    if (this.destroyed) {
      // Nobody is going to claim these, and they are real descriptors.
      if (msg.type === 'data' && msg.fds) closeFds(msg.fds);
      return;
    }
    switch (msg.type) {
      case 'data': {
        // Before the bytes, always. A message takes the descriptors its
        // UNIX_FDS header claims, so they have to be queued by the time the
        // parser reaches that header -- and SCM_RIGHTS can deliver them with
        // bytes that precede their own message, never after.
        if (msg.fds && msg.fds.length) this.emit('fds', msg.fds);
        const chunk = Buffer.from(
          msg.data.buffer,
          msg.data.byteOffset,
          msg.data.byteLength
        );
        if (this.push(chunk)) this._tell('r');
        else this._readPaused = true;
        return;
      }
      case 'writable':
        this._watchingWrite = false;
        this._flush();
        return;
      case 'eof':
        this.push(null);
        return;
      case 'error':
        this._fail(new Error(msg.message));
        return;
    }
  }

  _read() {
    if (!this._readPaused) return;
    this._readPaused = false;
    this._tell('r');
  }

  // ---- writing ------------------------------------------------------------

  /**
   * The seam: a write that carries descriptors alongside its bytes.
   *
   * The descriptors are duped here and the caller keeps its own, which is what
   * libdbus does and the only contract that works with a queue: a write may go
   * out a tick later, and a caller that closed its descriptor on return would
   * have handed us a number that means something else by then.
   */
  writeWithFds(bytes, fds) {
    if (fds.length > MAX_FDS) {
      // Thrown rather than reported on the connection, like the refusal in
      // index.js: it is the caller's message that cannot be sent, and nothing
      // about the connection is wrong.
      throw new Error(
        `a message may carry at most ${MAX_FDS} file descriptors, not ${fds.length}`
      );
    }
    if (this.destroyed || this.writableEnded) return false;
    const dups = [];
    for (const fd of fds) {
      const copy = libc.sym.dup(fd);
      if (copy < 0) {
        const err = libc.errno();
        closeFds(dups);
        this.destroy(
          new Error(`could not duplicate file descriptor ${fd} (errno ${err})`)
        );
        return false;
      }
      dups.push(copy);
    }
    this._tagged.push({ bytes, fds: dups });
    return this.write(bytes);
  }

  /** Descriptors that arrived and were never claimed by a message. */
  closeFds(fds) {
    closeFds(fds);
  }

  _write(chunk, encoding, cb) {
    this._writev([{ chunk, encoding }], cb);
  }

  _writev(chunks, cb) {
    // The callback answers for every chunk in this call, so it rides on the
    // last one: writes complete in order, so that is when they are all out.
    for (let i = 0; i < chunks.length; i++) {
      const buf = chunks[i].chunk;
      let fds = null;
      if (this._tagged.length > 0 && this._tagged[0].bytes === buf) {
        fds = this._tagged.shift().fds;
      }
      this._backlog.push({
        buf,
        off: 0,
        fds,
        cb: i === chunks.length - 1 ? cb : null
      });
    }
    this._flush();
  }

  /** Write as much of the backlog as the kernel will take, in order. */
  _flush() {
    // A write callback lets the Writable hand us the next buffered chunk
    // immediately, which lands back here. Re-entering is harmless -- the new
    // chunk goes on the end of the same queue -- but the outer loop is already
    // draining it, so let it.
    if (this._flushing) return;
    this._flushing = true;
    try {
      this._drain();
    } finally {
      this._flushing = false;
    }
  }

  _drain() {
    while (this._backlog.length > 0) {
      const item = this._backlog[0];
      const rest = item.buf.subarray(item.off);
      let sent = 0;
      if (rest.length > 0) {
        sent = item.fds
          ? sendmsgWithFds(this._fd, rest, item.fds)
          : sendPlain(this._fd, rest);
        if (sent < 0) {
          const err = libc.errno();
          // EMSGSIZE is how macOS says "no room for this one right now" when
          // it carries control data; everywhere else that is EAGAIN.
          if (err === EAGAIN || err === EINTR || err === EMSGSIZE) {
            this._watchWritable();
            return;
          }
          this._fail(
            new Error(`writing to the connection failed (errno ${err})`)
          );
          return;
        }
        if (item.fds) {
          // On the wire with the first byte the kernel took. Our dups have
          // done their job either way.
          closeFds(item.fds);
          item.fds = null;
        }
      }
      item.off += sent;
      if (item.off < item.buf.length) {
        this._watchWritable();
        return;
      }
      this._backlog.shift();
      if (item.cb) item.cb(null);
    }
    if (this._watchingWrite) {
      this._watchingWrite = false;
      this._tell('p');
    }
    if (this._finalCb) {
      const cb = this._finalCb;
      this._finalCb = null;
      libc.sym.shutdown(this._fd, SHUT_WR);
      cb(null);
    }
  }

  _watchWritable() {
    if (this._watchingWrite) return;
    this._watchingWrite = true;
    this._tell('o');
  }

  _final(cb) {
    this._finalCb = cb;
    this._flush();
  }

  // ---- teardown -----------------------------------------------------------

  _destroy(err, cb) {
    this._tell('s'); // the thread closes its dup and the wake pipe, then exits
    if (this._worker) {
      // A thread that somehow missed the stop byte must not hold the process
      // open on its own.
      this._worker.unref();
      this._worker = null;
    }
    if (this._wake >= 0) libc.sym.close(this._wake);
    this._wake = -1;
    // Queued writes are dropped, but the descriptors we duped for them are
    // ours to close.
    for (const item of this._backlog) if (item.fds) closeFds(item.fds);
    for (const item of this._tagged) closeFds(item.fds);
    this._backlog = [];
    this._tagged = [];
    if (this._fd >= 0) libc.sym.close(this._fd);
    this._fd = -1;
    cb(err || this._failure || null);
  }

  _fail(err) {
    if (this.destroyed) return;
    this._failure = err;
    this.destroy(err);
  }
}

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

/** Whether this runtime can carry descriptors at all. Cheap and memoised. */
function available() {
  return loadLibc() !== null;
}

/**
 * Connect to a unix socket, fd-capable.
 *
 * `target` is `{ path }` or `{ abstract }`. Returns a connected stream, or
 * null when this runtime cannot do it or anything at all went wrong -- the
 * caller then opens an ordinary socket, which fails the same way it always
 * did. Nothing here should turn a working connection into a broken one.
 */
function connect(target) {
  if (!available()) return null;
  const address = sockaddrUn(target);
  if (!address) return null; // name too long for sockaddr_un
  const fd = libc.sym.socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return null;
  // Blocking connect: a unix socket either has a listener or does not, and
  // this is the same descriptor an ordinary client would have connected
  // synchronously anyway.
  if (libc.sym.connect(fd, libc.ptr(address.sa), address.len) !== 0) {
    libc.sym.close(fd);
    return null;
  }
  if (!boundBlocking(fd)) {
    libc.sym.close(fd);
    return null;
  }
  const stream = new BunUnixSocket(fd);
  try {
    stream._startReader();
  } catch {
    stream.destroy();
    return null;
  }
  return stream;
}

module.exports = { available, connect, MAX_FDS };
