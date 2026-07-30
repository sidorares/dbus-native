// Reconnection, by actually killing the bus underneath a live service.
//
// BIG_FUTURE_PLANS 3.2. A daemon that loses the bus had no story at all, which
// matters for an audience that skews toward Raspberry Pi and Homebridge.
//
// The hard part was never the socket. A reconnect makes a *new client*: the
// unique name is different, no well-known name is owned, and no match rule
// exists. So the test that matters is not "did it reconnect" but "can anyone
// reach the service afterwards".
//
// Uses its own broker rather than the shared daemon, because the point is to
// stop the bus mid-run and nothing else in the suite would survive that.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dbus = require('../../index');

const SERVICE = 'com.github.sidorares.dbusnative.Reconnecting';
const PATH = '/com/github/sidorares/dbusnative/Reconnecting';
const IFACE = 'com.github.sidorares.dbusnative.ReconnectingIface';

const settle = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));

const once = (emitter, event) =>
  new Promise(resolve => emitter.once(event, (...args) => resolve(args)));

describe('integration: reconnect', { timeout: 30000 }, () => {
  let broker, address, dir, socketPath;

  // The test owns the socket path, so the bus can be stopped and started again
  // at the same address -- which is what a dbus-daemon restart looks like to a
  // client, and the only way to exercise reconnection honestly.
  const startBroker = () =>
    new Promise((resolve, reject) => {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* only there after the first run */
      }
      const b = dbus.createBroker();
      b.on('error', () => {});
      b.listen({ socket: socketPath }, (err, addr) => {
        if (err) return reject(err);
        address = addr;
        resolve(b);
      });
    });

  const stopBroker = () => new Promise(resolve => broker.close(resolve));

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-reconnect-'));
    socketPath = path.join(dir, 'bus');
    broker = await startBroker();
  });

  after(async () => {
    if (broker) await stopBroker();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const connect = extra => dbus.createClient({ busAddress: address, ...extra });

  it('is off unless asked for', async () => {
    const bus = connect();
    await bus.getId();
    const closed = once(bus.connection, 'close');
    bus.connection.stream.destroy();
    await closed;
    await settle();
    // No retry scheduled, no reconnect: the connection stays down.
    assert.strictEqual(bus.connection.state, 'disconnected');
  });

  it('refuses to pair with a caller-supplied stream', () => {
    // There is no way to reopen a stream we did not dial.
    const { PassThrough } = require('stream');
    assert.throws(
      () => dbus.createClient({ stream: new PassThrough(), reconnect: true }),
      /cannot be used with opts\.stream/
    );
  });

  it('validates its settings rather than misbehaving later', () => {
    for (const bad of [
      { minDelay: 0 },
      { maxDelay: -1 },
      { factor: 'fast' },
      { retries: 1.5 },
      { retries: -1 }
    ]) {
      assert.throws(
        () => dbus.createClient({ busAddress: address, reconnect: bad }),
        /reconnect\./,
        JSON.stringify(bad)
      );
    }
  });

  it('comes back, and brings the name and the match rules with it', async () => {
    const service = connect({ reconnect: { minDelay: 20, maxDelay: 50 } });
    await service.getId();
    await service.requestName(SERVICE, 0);

    const impl = dbus.defineInterface({
      name: IFACE,
      methods: {
        Echo: { in: { s: 's' }, out: { s: 's' }, handler: ({ s }) => s }
      },
      signals: { Fired: { args: { what: 's' } } }
    });
    await service.export(PATH, impl);

    // A rule of our own, to check it is reinstated.
    await service.addMatch(`type='signal',interface='${IFACE}',member='Fired'`);

    const firstName = service.name;
    assert.match(firstName, /^:\d+\.\d+$/);

    // Bring the bus down and back up on the same socket.
    const reconnected = once(service, 'reconnected');
    await stopBroker();
    await settle(50);
    broker = await startBroker();

    const [info] = await reconnected;

    // A new client, with a new unique name.
    assert.match(service.name, /^:\d+\.\d+$/);
    assert.strictEqual(info.name, service.name);
    assert.strictEqual(service.connection.state, 'connected');

    // And the thing that actually matters: reachable again, by name.
    assert.deepStrictEqual(info.names, [SERVICE]);
    const client = connect();
    await client.getId();
    assert.strictEqual(await client.nameHasOwner(SERVICE), true);
    const proxy = await client.proxy(SERVICE, PATH, { interface: IFACE });
    assert.strictEqual(await proxy.Echo('still here'), 'still here');

    // The match rule went back too.
    assert.ok(
      service.matchRules.has(
        `type='signal',interface='${IFACE}',member='Fired'`
      )
    );

    await client.close();
    await service.close();
  });

  it('reports each attempt while the bus is away', async () => {
    const bus = connect({ reconnect: { minDelay: 20, maxDelay: 40 } });
    await bus.getId();

    const attempts = [];
    bus.connection.on('reconnecting', info => attempts.push(info));

    await stopBroker();
    await settle(200);

    assert.ok(attempts.length >= 2, `expected retries, got ${attempts.length}`);
    assert.strictEqual(attempts[0].attempt, 1);
    // Backed off, and capped.
    assert.ok(attempts.every(a => a.delay <= 40));

    broker = await startBroker();
    await once(bus, 'reconnected');
    await bus.close();
  });

  it('gives up after the retries it was given', async () => {
    const bus = connect({
      reconnect: { retries: 2, minDelay: 10, maxDelay: 10 }
    });
    await bus.getId();

    const failed = once(bus.connection, 'reconnectFailed');
    await stopBroker();
    await failed;

    broker = await startBroker();
    await bus.close();
  });

  it('does not reconnect after a deliberate close', async () => {
    const bus = connect({ reconnect: { minDelay: 10 } });
    await bus.getId();

    let reconnecting = false;
    bus.connection.on('reconnecting', () => {
      reconnecting = true;
    });
    await bus.close();
    await settle(100);
    assert.strictEqual(reconnecting, false, 'close() means close');
  });

  it('fails calls made while it is down rather than replaying them', async () => {
    // A method call is not idempotent, so nothing in flight is retried. The
    // event is how a caller decides what to re-issue.
    const bus = connect({ reconnect: { minDelay: 20, maxDelay: 40 } });
    await bus.getId();

    await stopBroker();
    await settle(30);
    await assert.rejects(() => bus.getId());

    broker = await startBroker();
    await once(bus, 'reconnected');
    // And it works again afterwards.
    assert.match(await bus.getId(), /^[0-9a-f]{32}$/);
    await bus.close();
  });
});
