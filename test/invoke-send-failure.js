// A message the connection cannot write.
//
// Marshalling happens inside `connection.message()`, so a malformed object
// path or a body that does not match its signature fails at the send rather
// than on the wire. That used to throw out of `invoke()` *and* leave the call
// registered, so a caller got the exception immediately and a TimeoutError 25
// seconds later for a message that never left the process.

const { describe, it } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const MessageBus = require('../lib/bus');
const constants = require('../lib/constants');

/** A connection whose write always fails, the way marshalling does. */
function unsendable() {
  const conn = new EventEmitter();
  conn.attempts = 0;
  conn.message = () => {
    conn.attempts++;
    throw new Error('Data: bad/path is not a valid object path');
  };
  return conn;
}

const call = {
  destination: 'com.example.Service',
  path: '/com/example/Obj',
  interface: 'com.example.Iface',
  member: 'M'
};

describe('a message that cannot be written', () => {
  it('reports through the callback rather than throwing', () => {
    const bus = new MessageBus(unsendable(), { direct: true });
    let err;
    assert.doesNotThrow(() => {
      bus.invoke({ ...call }, e => {
        err = e;
      });
    });
    assert.match(err.message, /not a valid object path/);
  });

  it('reports exactly once', () => {
    const bus = new MessageBus(unsendable(), { direct: true });
    let calls = 0;
    bus.invoke({ ...call }, () => calls++);
    assert.strictEqual(calls, 1);
  });

  it('leaves nothing pending', () => {
    const bus = new MessageBus(unsendable(), { direct: true });
    bus.invoke({ ...call }, () => {});
    assert.deepStrictEqual(Object.keys(bus.cookies), []);
  });

  it('rejects the promise form', async () => {
    const bus = new MessageBus(unsendable(), { direct: true });
    await assert.rejects(() => bus.invoke({ ...call }), {
      message: /not a valid object path/
    });
  });

  it('does not retry the write', () => {
    const conn = unsendable();
    const bus = new MessageBus(conn, { direct: true });
    bus.invoke({ ...call }, () => {});
    assert.strictEqual(conn.attempts, 1);
  });

  // NO_REPLY_EXPECTED takes a different branch: it settles as soon as the
  // message is written and never registers a pending call, so there is no
  // later failure for the error to surface through.
  it('reports a no-reply message that could not be sent', () => {
    const bus = new MessageBus(unsendable(), { direct: true });
    let err;
    assert.doesNotThrow(() => {
      bus.invoke({ ...call, flags: constants.flags.noReplyExpected }, e => {
        err = e;
      });
    });
    assert.match(err.message, /not a valid object path/);
    assert.deepStrictEqual(Object.keys(bus.cookies), []);
  });

  it('leaves the bus usable for a message that is fine', () => {
    const conn = new EventEmitter();
    const sent = [];
    let failNext = true;
    conn.message = msg => {
      if (failNext) {
        failNext = false;
        throw new Error('Data: bad/path is not a valid object path');
      }
      sent.push(msg);
    };
    const bus = new MessageBus(conn, { direct: true });
    bus.invoke({ ...call }, () => {});
    bus.invoke({ ...call }, () => {});
    assert.strictEqual(sent.length, 1, 'the second call went out');
    assert.strictEqual(
      Object.keys(bus.cookies).length,
      1,
      'and is waiting for its reply'
    );
  });
});
