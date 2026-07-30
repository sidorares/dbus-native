// A stream pair that carries file descriptors, for testing the seam.
//
// Nothing in this package provides an fd-capable transport -- Node has no
// ancillary-data API and the addons that do need a compiler on every install,
// which is the property three releases were spent acquiring (ROADMAP 2.8). So
// the capability lives on the stream: supply one that implements
// `writeWithFds(bytes, fds)` and emits `'fds'`, and everything above works.
//
// This is that stream, minus the kernel. It is not a simulation of SCM_RIGHTS
// -- it does not dup, and the "descriptors" are whatever the test put in -- but
// it has the property that matters: fds arrive in the same order as the bytes
// they accompanied, which is what lets a message take its share by count.

const { Duplex } = require('stream');

class FdChannel extends Duplex {
  constructor() {
    super();
    this.peer = null;
    /** Every (bytes, fds) pair written through writeWithFds, for assertions. */
    this.sentWithFds = [];
    /** True once a plain write() happened, to catch fds leaking into a batch. */
    this.plainWrites = 0;
  }

  /** The seam: a write that carries descriptors alongside the bytes. */
  writeWithFds(bytes, fds) {
    this.sentWithFds.push({ bytes, fds: [...fds] });
    // Order matters and is the whole contract: the peer must see the fds
    // before it finishes parsing the message that claims them. Emitting first
    // is what a recvmsg() loop does -- ancillary data comes off the same call
    // as its bytes.
    if (this.peer) {
      this.peer.emit('fds', fds);
      this.peer.push(bytes);
    }
    return true;
  }

  _write(chunk, encoding, callback) {
    this.plainWrites++;
    if (this.peer) this.peer.push(chunk);
    callback();
  }

  _read() {}
}

/** Two channels wired to each other. */
function fdChannelPair() {
  const a = new FdChannel();
  const b = new FdChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** A Duplex with no fd capability at all, to check the refusal path. */
class PlainChannel extends Duplex {
  constructor() {
    super();
    this.peer = null;
  }
  _write(chunk, encoding, callback) {
    if (this.peer) this.peer.push(chunk);
    callback();
  }
  _read() {}
}

function plainChannelPair() {
  const a = new PlainChannel();
  const b = new PlainChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

module.exports = { FdChannel, fdChannelPair, PlainChannel, plainChannelPair };
