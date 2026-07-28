// diagnostics_channel instrumentation, observed against a real dbus-daemon.

const assert = require('assert');
const dc = require('node:diagnostics_channel');
const { EventEmitter } = require('events');
const dbus = require('../../index');

const SERVICE = 'com.github.sidorares.dbusnative.Diagnostics';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/Diagnostics';
const IFACE = 'com.github.sidorares.dbusnative.DiagnosticsIface';

const ifaceDesc = {
  name: IFACE,
  methods: { Echo: ['s', 's', ['in'], ['out']], Fail: ['', '', [], []] },
  signals: {},
  properties: {}
};

// Subscribe for the duration of one function call, then clean up.
async function watching(names, fn) {
  const seen = Object.fromEntries(names.map(n => [n, []]));
  const subs = names.map(name => {
    const handler = payload => seen[name].push(payload);
    dc.subscribe(name, handler);
    return () => dc.unsubscribe(name, handler);
  });
  try {
    await fn();
  } finally {
    subs.forEach(off => off());
  }
  return seen;
}

describe('integration: diagnostics_channel', function () {
  this.timeout(10000);

  let serviceBus, clientBus;

  before(async function () {
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) return this.skip();
    serviceBus = dbus.sessionBus();
    clientBus = dbus.sessionBus();

    const impl = Object.assign(Object.create(EventEmitter.prototype), {
      Echo: input => input,
      Fail: () => {
        const err = new Error('deliberate');
        err.dbusName = 'com.example.Error.Boom';
        throw err;
      }
    });
    EventEmitter.call(impl);

    await Promise.all([serviceBus.getId(), clientBus.getId()]);
    await serviceBus.requestName(SERVICE, 0);
    serviceBus.exportInterface(impl, OBJECT_PATH, ifaceDesc);
  });

  after(() => {
    if (serviceBus) serviceBus.connection.end();
    if (clientBus) clientBus.connection.end();
  });

  const call = (member, over = {}) => ({
    destination: SERVICE,
    path: OBJECT_PATH,
    interface: IFACE,
    member,
    ...over
  });

  it('publishes outbound and inbound messages', async () => {
    const seen = await watching(
      ['dbus:message:send', 'dbus:message:receive'],
      () => clientBus.invoke(call('Echo', { signature: 's', body: ['hi'] }))
    );

    const sent = seen['dbus:message:send'].map(p => p.message);
    assert.ok(
      sent.some(m => m.member === 'Echo' && m.destination === SERVICE),
      'the outbound call should be published'
    );

    const received = seen['dbus:message:receive'].map(p => p.message);
    assert.ok(received.length > 0, 'the reply should be published');
    assert.ok(received.some(m => m.body && m.body[0] === 'hi'));
  });

  it('traces a successful call from start to end', async () => {
    const seen = await watching(
      ['tracing:dbus:call:start', 'tracing:dbus:call:end'],
      () => clientBus.invoke(call('Echo', { signature: 's', body: ['traced'] }))
    );

    const started = seen['tracing:dbus:call:start'];
    assert.strictEqual(started.length, 1);
    assert.strictEqual(started[0].member, 'Echo');
    assert.strictEqual(started[0].destination, SERVICE);
    assert.strictEqual(started[0].interface, IFACE);

    const ended = seen['tracing:dbus:call:end'];
    assert.strictEqual(ended.length, 1);
    assert.strictEqual(ended[0].result, 'traced');
  });

  it('publishes the error channel when a call fails', async () => {
    const seen = await watching(
      ['tracing:dbus:call:error', 'tracing:dbus:call:end'],
      async () => {
        await assert.rejects(() => clientBus.invoke(call('Fail')));
      }
    );

    const errored = seen['tracing:dbus:call:error'];
    assert.strictEqual(errored.length, 1);
    assert.strictEqual(errored[0].member, 'Fail');
    assert.ok(errored[0].error, 'the error should be attached');
    // end still fires, so a subscriber can time every call uniformly
    assert.strictEqual(seen['tracing:dbus:call:end'].length, 1);
  });

  it('can time a call, which is the point of the tracing channel', async () => {
    let elapsed = null;
    const started = new Map();
    const onStart = ctx => started.set(ctx, process.hrtime.bigint());
    const onEnd = ctx => {
      if (started.has(ctx)) {
        elapsed = Number(process.hrtime.bigint() - started.get(ctx)) / 1e6;
      }
    };
    dc.subscribe('tracing:dbus:call:start', onStart);
    dc.subscribe('tracing:dbus:call:end', onEnd);
    try {
      await clientBus.invoke(call('Echo', { signature: 's', body: ['timed'] }));
    } finally {
      dc.unsubscribe('tracing:dbus:call:start', onStart);
      dc.unsubscribe('tracing:dbus:call:end', onEnd);
    }
    assert.ok(elapsed !== null, 'start and end should share a context object');
    assert.ok(elapsed >= 0 && elapsed < 5000, `implausible timing: ${elapsed}`);
  });

  it('publishes nothing once unsubscribed', async () => {
    const seen = [];
    const handler = p => seen.push(p);
    dc.subscribe('dbus:message:send', handler);
    dc.unsubscribe('dbus:message:send', handler);
    await clientBus.invoke(call('Echo', { signature: 's', body: ['quiet'] }));
    assert.deepStrictEqual(seen, []);
  });
});
