// Timeouts and cancellation against a real dbus-daemon, including a service
// method that deliberately never replies.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const { sessionBus } = require('../utils/shape');

// node:test skips a whole suite from its options, evaluated at load time.
const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Timeouts';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/Timeouts';
const IFACE = 'com.github.sidorares.dbusnative.TimeoutsIface';

const ifaceDesc = {
  name: IFACE,
  methods: {
    Quick: ['', 's', [], ['out']],
    NeverReplies: ['', 's', [], ['out']]
  },
  signals: {},
  properties: {}
};

describe(
  'integration: timeouts and cancellation',
  { timeout: 15000, skip: NO_BUS },
  () => {
    let serviceBus, clientBus;

    before(async () => {
      serviceBus = sessionBus();
      clientBus = sessionBus();

      const impl = Object.assign(Object.create(EventEmitter.prototype), {
        Quick: () => 'here',
        // returning a promise that never settles means no reply is ever sent
        NeverReplies: () => new Promise(() => {})
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

    const call = member => ({
      destination: SERVICE,
      path: OBJECT_PATH,
      interface: IFACE,
      member
    });

    it('a call that gets a reply is unaffected by a timeout', async () => {
      const result = await clientBus.invoke(call('Quick'), { timeout: 5000 });
      assert.strictEqual(result, 'here');
    });

    it('times out a call that never gets a reply', async () => {
      const started = Date.now();
      await assert.rejects(
        () => clientBus.invoke(call('NeverReplies'), { timeout: 150 }),
        { name: 'TimeoutError', code: 'ETIMEDOUT' }
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 140, `returned too early: ${elapsed}ms`);
      assert.ok(elapsed < 2000, `returned too late: ${elapsed}ms`);
    });

    it('does not leak the pending call after a timeout', async () => {
      const before = Object.keys(clientBus.cookies).length;
      await assert.rejects(() =>
        clientBus.invoke(call('NeverReplies'), { timeout: 100 })
      );
      assert.strictEqual(Object.keys(clientBus.cookies).length, before);
    });

    it('cancels an in-flight call through an AbortController', async () => {
      const ac = new AbortController();
      const pending = clientBus.invoke(call('NeverReplies'), {
        signal: ac.signal
      });
      setTimeout(() => ac.abort(new Error('changed my mind')), 50);
      await assert.rejects(
        () => pending,
        err => {
          assert.strictEqual(err.name, 'AbortError');
          assert.strictEqual(err.cause.message, 'changed my mind');
          return true;
        }
      );
    });

    it('works with AbortSignal.timeout()', async () => {
      await assert.rejects(
        () =>
          clientBus.invoke(call('NeverReplies'), {
            signal: AbortSignal.timeout(120)
          }),
        { name: 'AbortError' }
      );
    });

    it('honours a client-wide default timeout', async () => {
      const impatient = sessionBus({ timeout: 120 });
      try {
        await impatient.getId();
        await assert.rejects(() => impatient.invoke(call('NeverReplies')), {
          name: 'TimeoutError'
        });
      } finally {
        impatient.connection.end();
      }
    });

    it('leaves the connection usable after a timeout', async () => {
      await assert.rejects(() =>
        clientBus.invoke(call('NeverReplies'), { timeout: 80 })
      );
      assert.strictEqual(
        await clientBus.invoke(call('Quick'), { timeout: 5000 }),
        'here'
      );
    });

    // The default is 25 seconds, which is far too long to wait for here. What
    // can be checked against a real daemon is that a call made with no options
    // at all now *has* a deadline -- before 2.0 it had none, and this would
    // have stayed pending until the process ended.
    it('gives a call with no options a deadline of its own', async () => {
      const pending = clientBus.invoke(call('NeverReplies'));
      const [serial] = Object.keys(clientBus.cookies);
      assert.ok(serial, 'the call is pending');

      // Settle it by hand rather than waiting 25s: what is being asserted is
      // that the machinery armed a deadline, which the unit test pins to the
      // exact figure.
      clientBus.cookies[serial](
        Object.assign(new Error('stand-in'), { name: 'TimeoutError' })
      );
      await assert.rejects(() => pending, { name: 'TimeoutError' });
      assert.strictEqual(
        Object.keys(clientBus.cookies).length,
        0,
        'and cleaned up after itself'
      );
    });

    it('sends a no-reply message without waiting for one', async () => {
      const { flags } = require('../../lib/constants');
      const before = Object.keys(clientBus.cookies).length;
      const result = await clientBus.invoke({
        ...call('NeverReplies'),
        flags: flags.noReplyExpected
      });
      assert.strictEqual(result, undefined);
      assert.strictEqual(
        Object.keys(clientBus.cookies).length,
        before,
        'left nothing pending'
      );
      // The connection is fine, and the service really did get the message.
      assert.strictEqual(await clientBus.invoke(call('Quick')), 'here');
    });
  }
);
