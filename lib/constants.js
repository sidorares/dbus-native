module.exports = {
  messageType: {
    invalid: 0,
    methodCall: 1,
    methodReturn: 2,
    error: 3,
    signal: 4
  },

  // Field 9 is UNIX_FDS: how many descriptors accompany this message. It used
  // to be absent, which meant a peer that sent one produced `msg.undefined = 2`
  // -- harmless only because we never asked for fd passing, so nothing sent it.
  headerTypeName: [
    null,
    'path',
    'interface',
    'member',
    'errorName',
    'replySerial',
    'destination',
    'sender',
    'signature',
    'unixFds'
  ],

  // TODO: merge to single hash? e.g path -> [1, 'o']
  fieldSignature: {
    path: 'o',
    interface: 's',
    member: 's',
    errorName: 's',
    replySerial: 'u',
    destination: 's',
    sender: 's',
    signature: 'g',
    unixFds: 'u'
  },
  headerTypeId: {
    path: 1,
    interface: 2,
    member: 3,
    errorName: 4,
    replySerial: 5,
    destination: 6,
    sender: 7,
    signature: 8,
    unixFds: 9
  },
  protocolVersion: 1,
  flags: {
    noReplyExpected: 1,
    noAutoStart: 2
  },
  endianness: {
    le: 108,
    be: 66
  },
  messageSignature: 'yyyyuua(yv)',
  defaultAuthMethods: ['EXTERNAL', 'DBUS_COOKIE_SHA1', 'ANONYMOUS'],

  // Hard limits from the specification. A peer declaring anything larger is
  // sending us a protocol error, and we must not try to buffer it.
  // https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-messages
  maxMessageSize: 134217728, // 128 MiB
  maxArraySize: 67108864, // 64 MiB

  /**
   * Why a type is refused, said the same way in both directions.
   *
   * `h` gets its own explanation because "unknown type" is misleading: the
   * signature parses, the type is real, and the reason it cannot be carried
   * has nothing to do with this library not recognising it. People rediscover
   * that repeatedly, so the message says it outright.
   */
  unsupportedType(type) {
    return `Unknown data type format: ${type}`;
  },

  /**
   * Why a message carrying descriptors could not be sent or received.
   *
   * `h` itself marshals fine -- it is a uint32 index into the message's fd
   * array, exactly as the spec defines it. What is missing is a transport that
   * can carry the descriptors alongside the bytes, because a file descriptor
   * travels as ancillary data (SCM_RIGHTS) rather than in the body, and Node
   * has no API for that: nodejs/node#53391 is closed as not planned.
   *
   * So the seam is on the stream. Under Bun this package supplies one itself
   * (lib/transport-bun.js, used automatically for unix connections); anywhere
   * else, supply one that implements `writeWithFds` and emits `'fds'` -- see
   * docs/api.md, "File descriptors" -- and everything above it works. This
   * affects systemd, the XDG desktop portals and PipeWire.
   */
  noFdTransport(direction) {
    return (
      `This message carries file descriptors, which cannot be ${direction}: ` +
      'the stream does not support them. A descriptor is passed as ancillary ' +
      'data (SCM_RIGHTS) alongside the message rather than inside it, and Node ' +
      'has no API for that -- https://github.com/nodejs/node/issues/53391 is ' +
      'closed as not planned. Under Bun this works on any unix connection, ' +
      'unless `fdTransport: false` turned it off. On Node, pass your own ' +
      'transport as `opts.stream`, implementing writeWithFds(bytes, fds) and ' +
      "emitting 'fds'. See docs/api.md and ROADMAP.md section 2.8."
    );
  }
};
