// Call timeouts and AbortSignal support, and the pending-call bookkeeping
// that goes with them.

const assert = require('assert');
const { EventEmitter } = require('events');
const MessageBus = require('../lib/bus');
const constants = require('../lib/constants');

// A connection that records what was sent and lets a test reply by hand.
function fakeBus(opts = {}) {
  const sent = [];
  const conn = new EventEmitter();
  conn.message = msg => sent.push(msg);
  const bus = new MessageBus(conn, { direct: true, ...opts });
  return {
    bus,
    sent,
    reply(serial, body = []) {
      conn.emit('message', {
        type: constants.messageType.methodReturn,
        replySerial: serial,
        body
      });
    }
  };
}

const call = { destination: 'a.b', path: '/p', interface: 'a.b', member: 'M' };

describe('call timeouts', () => {
  it('rejects with a TimeoutError when no reply arrives', async () => {
    const { bus } = fakeBus();
    await assert.rejects(
      () => bus.invoke({ ...call }, { timeout: 30 }),
      err => {
        assert.strictEqual(err.name, 'TimeoutError');
        assert.strictEqual(err.code, 'ETIMEDOUT');
        assert.strictEqual(err.dbusName, 'org.freedesktop.DBus.Error.NoReply');
        assert.strictEqual(err.timeout, 30);
        assert.match(err.message, /a\.b\.M/);
        return true;
      }
    );
  });

  // Without this, every call that never gets an answer leaves an entry behind.
  it('removes the pending entry when it times out', async () => {
    const { bus } = fakeBus();
    assert.strictEqual(Object.keys(bus.cookies).length, 0);
    const pending = bus.invoke({ ...call }, { timeout: 20 });
    assert.strictEqual(Object.keys(bus.cookies).length, 1);
    await assert.rejects(() => pending);
    assert.strictEqual(
      Object.keys(bus.cookies).length,
      0,
      'pending call leaked'
    );
  });

  it('does not fire once the reply has arrived', async () => {
    const { bus, sent, reply } = fakeBus();
    const pending = bus.invoke({ ...call }, { timeout: 50 });
    reply(sent[0].serial, ['ok']);
    assert.strictEqual(await pending, 'ok');
    await new Promise(resolve => setTimeout(resolve, 80)); // past the timeout
    assert.strictEqual(Object.keys(bus.cookies).length, 0);
  });

  it('applies a client-wide default timeout', async () => {
    const { bus } = fakeBus({ timeout: 25 });
    await assert.rejects(() => bus.invoke({ ...call }), {
      name: 'TimeoutError'
    });
  });

  it('lets a per-call timeout override the client default', async () => {
    const { bus, sent, reply } = fakeBus({ timeout: 10 });
    const pending = bus.invoke({ ...call }, { timeout: 0 }); // 0 disables
    setTimeout(() => reply(sent[0].serial, ['slow but fine']), 40);
    assert.strictEqual(await pending, 'slow but fine');
  });

  it('waits forever by default, as it always has', async () => {
    const { bus, sent, reply } = fakeBus();
    const pending = bus.invoke({ ...call });
    setTimeout(() => reply(sent[0].serial, ['eventually']), 60);
    assert.strictEqual(await pending, 'eventually');
  });

  it('reports the timeout through a callback too', done => {
    const { bus } = fakeBus();
    bus.invoke({ ...call }, { timeout: 20 }, err => {
      assert.strictEqual(err.name, 'TimeoutError');
      done();
    });
  });
});

describe('AbortSignal', () => {
  it('rejects when aborted in flight', async () => {
    const { bus } = fakeBus();
    const ac = new AbortController();
    const pending = bus.invoke({ ...call }, { signal: ac.signal });
    setImmediate(() => ac.abort());
    await assert.rejects(
      () => pending,
      err => {
        assert.strictEqual(err.name, 'AbortError');
        assert.strictEqual(err.code, 'ABORT_ERR');
        return true;
      }
    );
  });

  it('does not send the message when the signal is already aborted', async () => {
    const { bus, sent } = fakeBus();
    await assert.rejects(
      () => bus.invoke({ ...call }, { signal: AbortSignal.abort() }),
      { name: 'AbortError' }
    );
    assert.deepStrictEqual(sent, [], 'nothing should have been written');
  });

  it('removes the pending entry when aborted', async () => {
    const { bus } = fakeBus();
    const ac = new AbortController();
    const pending = bus.invoke({ ...call }, { signal: ac.signal });
    assert.strictEqual(Object.keys(bus.cookies).length, 1);
    ac.abort();
    await assert.rejects(() => pending);
    assert.strictEqual(Object.keys(bus.cookies).length, 0);
  });

  it('surfaces the abort reason as the cause', async () => {
    const { bus } = fakeBus();
    const ac = new AbortController();
    const reason = new Error('user cancelled');
    const pending = bus.invoke({ ...call }, { signal: ac.signal });
    ac.abort(reason);
    await assert.rejects(
      () => pending,
      err => {
        assert.strictEqual(err.cause, reason);
        return true;
      }
    );
  });

  it('works with AbortSignal.timeout()', async () => {
    const { bus } = fakeBus();
    await assert.rejects(
      () => bus.invoke({ ...call }, { signal: AbortSignal.timeout(20) }),
      { name: 'AbortError' }
    );
  });

  it('stops listening to the signal once the reply arrives', async () => {
    const { bus, sent, reply } = fakeBus();
    const ac = new AbortController();
    const pending = bus.invoke({ ...call }, { signal: ac.signal });
    reply(sent[0].serial, ['done']);
    assert.strictEqual(await pending, 'done');
    // aborting afterwards must not produce an unhandled rejection
    ac.abort();
    await new Promise(setImmediate);
  });
});
