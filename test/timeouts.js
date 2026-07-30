// Call timeouts and AbortSignal support, and the pending-call bookkeeping
// that goes with them.

const { describe, it, before, after } = require('node:test');
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

// `bus.invoke` unrefs its timeout timer on purpose, so that a pending call
// does not hold the process open by itself -- a real connection's socket does
// that while it is alive. `fakeBus` has no socket, so nothing here is ref'd
// and the event loop would drain before the timer ever fires, which the test
// runner reports as "still pending but the event loop has already resolved".
//
// Stand in for the socket: hold one ref'd handle for the length of the suite.
function keepEventLoopAlive() {
  let handle;
  before(() => {
    handle = setInterval(() => {}, 1 << 30);
  });
  after(() => clearInterval(handle));
}

describe('call timeouts', () => {
  keepEventLoopAlive();

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

  it('reports the timeout through a callback too', (t, done) => {
    const { bus } = fakeBus();
    bus.invoke({ ...call }, { timeout: 20 }, err => {
      assert.strictEqual(err.name, 'TimeoutError');
      done();
    });
  });
});

// A call with no deadline never settles when the peer does not answer -- not
// slowly, not with an error, never. Any peer can cause it by crashing between
// receiving a message and replying, so waiting forever turns one program's bug
// into another's hang.
describe('the default deadline', () => {
  keepEventLoopAlive();

  /** The delays passed to setTimeout while `fn` runs. */
  const armedDelays = fn => {
    const delays = [];
    const real = global.setTimeout;
    global.setTimeout = (cb, ms) => {
      delays.push(ms);
      return real(cb, ms);
    };
    try {
      return { delays, result: fn() };
    } finally {
      global.setTimeout = real;
    }
  };

  it('is 25 seconds, matching libdbus, GDBus and sd-bus', () => {
    // Too long to wait for, so this reads the delay the timer was armed with
    // rather than letting it fire.
    const { bus } = fakeBus();
    const { delays } = armedDelays(() => bus.invoke({ ...call }, () => {}));
    assert.deepStrictEqual(delays, [25000]);
  });

  it('reports that number to the caller when it fires', async () => {
    // What a caller is told has to be the deadline they were actually given,
    // since that is the number they would adjust.
    const { bus } = fakeBus({ timeout: 20 });
    await assert.rejects(
      () => bus.invoke({ ...call }),
      err => {
        assert.strictEqual(err.name, 'TimeoutError');
        assert.strictEqual(err.timeout, 20);
        return true;
      }
    );
  });

  it('is turned off by timeout: 0, per call', async () => {
    const { bus, sent, reply } = fakeBus();
    const pending = bus.invoke({ ...call }, { timeout: 0 });
    setTimeout(() => reply(sent[0].serial, ['eventually']), 60);
    assert.strictEqual(await pending, 'eventually');
  });

  it('is turned off by timeout: 0, per client', async () => {
    const { bus, sent, reply } = fakeBus({ timeout: 0 });
    const pending = bus.invoke({ ...call });
    setTimeout(() => reply(sent[0].serial, ['eventually']), 60);
    assert.strictEqual(await pending, 'eventually');
  });

  it('does not arm a deadline for a message expecting no reply', async () => {
    // NO_REPLY_EXPECTED means the peer must not answer, so a deadline would
    // report a failure for a message that did exactly what it was told.
    const { bus, sent } = fakeBus();
    const { delays, result } = armedDelays(() =>
      bus.invoke({ ...call, flags: constants.flags.noReplyExpected })
    );
    assert.strictEqual(await result, undefined, 'settles with nothing');
    assert.deepStrictEqual(delays, [], 'and armed no timer');
    assert.strictEqual(sent.length, 1, 'but did send the message');
  });

  it('leaves no pending entry for a message expecting no reply', async () => {
    // It used to register a cookie against a serial that could never arrive,
    // which is one leaked entry per call for the life of the connection.
    const { bus } = fakeBus();
    await bus.invoke({ ...call, flags: constants.flags.noReplyExpected });
    assert.deepStrictEqual(Object.keys(bus.cookies), []);
  });
});

describe('AbortSignal', () => {
  keepEventLoopAlive();

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
