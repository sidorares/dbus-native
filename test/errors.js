// The 0.7 error contract: what a failed call actually hands you.
//
// The error-reply path needs a real daemon and lives in test/integration; what
// is unit-testable here is everything raised locally -- a dead connection, the
// empty-body fallback, and the compat shim.

const { after, before, describe, it } = require('node:test');
const assert = require('assert');
const { Duplex } = require('stream');
const dbus = require('../index');
const { toClassicError } = require('../lib/compat');
const {
  DBusError,
  ConnectionClosedError,
  fromReply
} = require('../lib/errors');
const constants = require('../lib/constants');

class FakeSocket extends Duplex {
  _write(chunk, enc, cb) {
    cb();
  }
  _read() {}
}

// Complete the SASL handshake by hand so the bus reaches 'connect'. `direct`
// skips the Hello call, which would otherwise be the first pending cookie.
function connectBus() {
  return new Promise(resolve => {
    const socket = new FakeSocket();
    const bus = dbus.createClient({ stream: socket, direct: true });
    setImmediate(() => socket.push('OK 0123456789abcdef\r\n'));
    bus.connection.once('connect', () => resolve({ bus, socket }));
  });
}

const aCall = {
  destination: 'com.example.Svc',
  path: '/com/example/Svc',
  interface: 'com.example.Iface',
  member: 'Method'
};

describe('errors: a connection that goes away', () => {
  it('fails calls that were still waiting for a reply', async () => {
    const { bus, socket } = await connectBus();
    const failed = new Promise(resolve => bus.invoke(aCall, resolve));

    socket.push(null); // remote hangs up

    const err = await failed;
    assert.ok(err instanceof ConnectionClosedError, `got ${err}`);
    assert.ok(err instanceof DBusError);
    assert.strictEqual(err.code, 'ECONNCLOSED');
    assert.strictEqual(err.dbusName, 'org.freedesktop.DBus.Error.Disconnected');
    // names the call, so the failure says which one it was
    assert.match(err.message, /com\.example\.Iface\.Method/);
  });

  it('fails every pending call, not just the first', async () => {
    const { bus, socket } = await connectBus();
    const failures = [1, 2, 3].map(
      n =>
        new Promise(resolve =>
          bus.invoke({ ...aCall, member: `Method${n}` }, resolve)
        )
    );

    socket.push(null);

    const errs = await Promise.all(failures);
    assert.strictEqual(errs.length, 3);
    for (const err of errs) assert.ok(err instanceof ConnectionClosedError);
    assert.deepStrictEqual(
      errs.map(e => /Method\d/.exec(e.message)[0]),
      ['Method1', 'Method2', 'Method3']
    );
  });

  it('rejects the promise form too', async () => {
    const { bus, socket } = await connectBus();
    const call = bus.invoke(aCall);
    socket.push(null);
    await assert.rejects(call, err => {
      assert.ok(err instanceof ConnectionClosedError);
      return true;
    });
  });

  it('fails calls made after the connection is gone', async () => {
    const { bus, socket } = await connectBus();
    socket.push(null);
    await new Promise(resolve => bus.connection.once('end', resolve));

    const err = await new Promise(resolve => bus.invoke(aCall, resolve));
    assert.ok(err instanceof ConnectionClosedError);
  });

  it('does not leave the failed calls in the cookie table', async () => {
    const { bus, socket } = await connectBus();
    bus.invoke(aCall, () => {});
    socket.push(null);
    await new Promise(resolve => bus.connection.once('end', resolve));
    assert.deepStrictEqual(Object.keys(bus.cookies), []);
  });

  it('does not swallow an unhandled connection error', async () => {
    // Attaching an 'error' listener to the connection would stop Node from
    // crashing on an unhandled one. The bus must not do that on the user's
    // behalf, so nothing should be listening unless the user asked.
    const { bus } = await connectBus();
    assert.strictEqual(bus.connection.listenerCount('error'), 0);
  });
});

// #393: a bus that accepts the socket and authenticates, then never answers
// Hello. The failure used to be thrown from the reply timer, out of reach of
// any listener, and took the process down.
describe('errors: a bus that never answers Hello', () => {
  // The Hello and handshake timers are unref'd, and a FakeSocket holds nothing
  // open, so stand in for a real socket as test/timeouts.js does. Without it
  // Node 22 sees the event loop drain before the timer fires.
  let handle;
  before(() => {
    handle = setInterval(() => {}, 1 << 30);
  });
  after(() => clearInterval(handle));

  function silentBus(authenticate = true) {
    const socket = new FakeSocket();
    const bus = dbus.createClient({ stream: socket, timeout: 20 });
    if (authenticate)
      setImmediate(() => socket.push('OK 0123456789abcdef\r\n'));
    return { bus, socket };
  }

  it('reports the failure as a connection error and closes', async () => {
    const { bus } = silentBus();
    let err;
    bus.connection.on('error', e => (err = e));
    const closedBy = await new Promise(resolve =>
      bus.connection.once('close', resolve)
    );
    assert.strictEqual(err.name, 'TimeoutError');
    assert.match(err.message, /org\.freedesktop\.DBus\.Hello/);
    assert.strictEqual(closedBy, err);
    assert.strictEqual(bus.connection.lastError, err);
    assert.strictEqual(bus.name, undefined);
  });

  it('fails pending calls with the Hello failure as the cause', async () => {
    const { bus } = silentBus();
    bus.connection.on('error', () => {});
    const failed = new Promise(resolve =>
      bus.invoke(aCall, { timeout: 0 }, resolve)
    );
    const err = await failed;
    assert.ok(err instanceof ConnectionClosedError, `got ${err}`);
    assert.strictEqual(err.cause.name, 'TimeoutError');
  });

  it('reports it once when the handshake never finishes either', async () => {
    const { bus } = silentBus(false);
    const errors = [];
    bus.connection.on('error', err => errors.push(err));
    await new Promise(resolve => bus.connection.once('close', resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(
      errors.map(err => err.name),
      ['TimeoutError']
    );
  });
});

describe('errors: fromReply', () => {
  const reply = (errorName, body) => ({
    type: constants.messageType.error,
    errorName,
    body
  });

  it('uses the first body string as the message', () => {
    const err = fromReply(reply('com.example.Error.Boom', ['it broke']));
    assert.strictEqual(err.message, 'it broke');
    assert.strictEqual(err.dbusName, 'com.example.Error.Boom');
    assert.strictEqual(err.name, 'DBusError');
  });

  it('falls back to the error name when the body is empty', () => {
    // This is the `err` that used to be `[]` -- an error that rendered as
    // nothing at all.
    const err = fromReply(reply('com.example.Error.Silent', []));
    assert.strictEqual(err.message, 'com.example.Error.Silent');
    assert.ok(err.message.length > 0);
  });

  it('still says something with neither a body nor a name', () => {
    const err = fromReply(reply(undefined, undefined));
    assert.strictEqual(err.message, 'D-Bus error with no message');
    assert.deepStrictEqual(err.body, []);
  });

  it('keeps the body and the reply for callers that want them', () => {
    const msg = reply('com.example.Error.Boom', ['it broke', 42]);
    const err = fromReply(msg);
    assert.deepStrictEqual(err.body, ['it broke', 42]);
    assert.strictEqual(err.reply, msg);
  });
});

describe('errors: dbus-native/compat', () => {
  it('turns a reply error back into the pre-0.7 array', () => {
    const err = fromReply({
      errorName: 'com.example.Error.Boom',
      body: ['it broke']
    });
    const classic = toClassicError(err);

    assert.ok(Array.isArray(classic));
    assert.deepStrictEqual([...classic], ['it broke']);
    assert.strictEqual(classic.message, 'it broke');
    assert.strictEqual(classic.dbusName, 'com.example.Error.Boom');
    assert.strictEqual(classic.name, 'DBusError');
  });

  it('restores the old JSON serialisation', () => {
    const err = fromReply({ errorName: 'x.y.Z', body: ['boom'] });
    assert.strictEqual(JSON.stringify(toClassicError(err)), '["boom"]');
  });

  it('leaves locally-raised errors alone', () => {
    // A timeout or a dead connection never had an array form, so flattening
    // one to `[]` would invent a shape that no released version produced.
    const err = new ConnectionClosedError(aCall);
    assert.strictEqual(toClassicError(err), err);
  });

  it('is a no-op on values it did not produce', () => {
    assert.strictEqual(toClassicError(null), null);
    assert.strictEqual(toClassicError(undefined), undefined);
    const plain = new Error('unrelated');
    assert.strictEqual(toClassicError(plain), plain);
    const already = ['classic'];
    assert.strictEqual(toClassicError(already), already);
  });
});

// The export surface itself is asserted in test/exports.js.
