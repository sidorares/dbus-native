module.exports = {
  messageType: {
    invalid: 0,
    methodCall: 1,
    methodReturn: 2,
    error: 3,
    signal: 4
  },

  headerTypeName: [
    null,
    'path',
    'interface',
    'member',
    'errorName',
    'replySerial',
    'destination',
    'sender',
    'signature'
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
    signature: 'g'
  },
  headerTypeId: {
    path: 1,
    interface: 2,
    member: 3,
    errorName: 4,
    replySerial: 5,
    destination: 6,
    sender: 7,
    signature: 8
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
  unsupportedType(type, direction) {
    if (type === 'h') {
      return (
        `UNIX_FD ('h') is not supported, so this message cannot be ${direction}. ` +
        'A file descriptor does not travel in the message body -- it is passed ' +
        'as ancillary data (SCM_RIGHTS) alongside it, and Node has no API for ' +
        'that: https://github.com/nodejs/node/issues/53391 is closed as not ' +
        'planned. See ROADMAP.md section 2.8 for what it would take. This ' +
        'affects systemd, the XDG desktop portals and PipeWire.'
      );
    }
    return `Unknown data type format: ${type}`;
  }
};
