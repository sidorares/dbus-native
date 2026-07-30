// Scoped resources: bus.close(), bus.watch(), bus.ownName(), and the
// Symbol.asyncDispose that lets the language release all three.
//
// BIG_FUTURE_PLANS 1. The value is not the syntax, it is that a match rule
// removed by leaving a scope is one nobody has to remember to remove -- and
// forgetting is why a long-lived process ends up being sent signals nothing
// still listens for.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { sessionBus } = require('../utils/shape');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const NAME = 'com.github.sidorares.dbusnative.Scoped';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/Scoped';
const IFACE = 'com.github.sidorares.dbusnative.ScopedIface';

const settle = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));

describe(
  'integration: scoped resources',
  { timeout: 15000, skip: NO_BUS },
  () => {
    let helper;

    const whenReady = bus =>
      new Promise((resolve, reject) =>
        bus.getId(err => (err ? reject(err) : resolve()))
      );

    before(async () => {
      helper = sessionBus();
      await whenReady(helper);
    });

    after(async () => {
      if (helper) await helper.close();
    });

    describe('bus.close()', () => {
      it('resolves once the connection is really gone', async () => {
        const bus = sessionBus();
        await whenReady(bus);
        await bus.close();
        assert.strictEqual(bus.connection.stream.destroyed, true);
      });

      it('fails in-flight calls rather than leaving them waiting', async () => {
        const bus = sessionBus();
        await whenReady(bus);
        // A call to a name nobody owns and nobody will answer, closed underneath.
        const pending = bus.invoke({
          destination: NAME,
          path: OBJECT_PATH,
          interface: IFACE,
          member: 'NeverAnswered'
        });
        const settledWith = pending.then(
          () => 'resolved',
          err => err.constructor.name
        );
        await bus.close();
        // Either the daemon's ServiceUnknown got there first or the close did;
        // what matters is that it settled at all.
        const outcome = await settledWith;
        assert.ok(
          ['DBusError', 'ConnectionClosedError'].includes(outcome),
          `expected an error, got ${outcome}`
        );
      });

      it('flushes a message sent immediately before it', async () => {
        // writeMessage corks and uncorks on nextTick, so closing in the same
        // tick as the last send is exactly the case that could drop it.
        const listener = sessionBus();
        await whenReady(listener);
        const sub = await listener.watch(
          `type='signal',interface='${IFACE}',member='Parting'`
        );
        const seen = [];
        listener.signals.on(
          listener.mangle(OBJECT_PATH, IFACE, 'Parting'),
          body => seen.push(body)
        );

        const sender = sessionBus();
        await whenReady(sender);
        sender.sendSignal(OBJECT_PATH, IFACE, 'Parting', 's', ['last words']);
        await sender.close();

        await settle();
        assert.deepStrictEqual(seen, [['last words']]);
        await sub.remove();
        await listener.close();
      });

      it('is idempotent, and safe on a connection already gone', async () => {
        const bus = sessionBus();
        await whenReady(bus);
        await bus.close();
        await bus.close();
        await bus.close();
      });

      it('is what Symbol.asyncDispose does', async () => {
        const bus = sessionBus();
        await whenReady(bus);
        assert.strictEqual(typeof bus[Symbol.asyncDispose], 'function');
        await bus[Symbol.asyncDispose]();
        assert.strictEqual(bus.connection.stream.destroyed, true);
      });

      it('works on a raw connection too', async () => {
        const bus = sessionBus();
        await whenReady(bus);
        const conn = bus.connection;
        assert.strictEqual(typeof conn[Symbol.asyncDispose], 'function');
        await conn[Symbol.asyncDispose]();
        assert.strictEqual(conn.stream.destroyed, true);
      });
    });

    describe('bus.watch()', () => {
      const emit = payload =>
        helper.sendSignal(OBJECT_PATH, IFACE, 'Watched', 's', [payload]);

      const collector = bus => {
        const seen = [];
        bus.signals.on(bus.mangle(OBJECT_PATH, IFACE, 'Watched'), body =>
          seen.push(body[0])
        );
        return seen;
      };

      it('delivers while the subscription is alive', async () => {
        const bus = sessionBus();
        await whenReady(bus);
        const seen = collector(bus);
        const sub = await bus.watch(
          `type='signal',interface='${IFACE}',member='Watched'`
        );

        emit('one');
        await settle();
        assert.deepStrictEqual(seen, ['one']);

        await sub.remove();
        await bus.close();
      });

      it('stops delivering once removed', async () => {
        const bus = sessionBus();
        await whenReady(bus);
        const seen = collector(bus);
        const sub = await bus.watch(
          `type='signal',interface='${IFACE}',member='Watched'`
        );

        emit('before');
        await settle();
        await sub.remove();
        emit('after');
        await settle();

        assert.deepStrictEqual(seen, ['before'], 'the rule really went away');
        await bus.close();
      });

      it('removes through Symbol.asyncDispose, and only once', async () => {
        const bus = sessionBus();
        await whenReady(bus);
        const sub = await bus.watch(
          `type='signal',interface='${IFACE}',member='Watched'`
        );
        await sub[Symbol.asyncDispose]();
        assert.strictEqual(sub.removed, true);
        // A second RemoveMatch for a rule that is gone is an error on the bus,
        // so this passing is the guard working.
        await sub[Symbol.asyncDispose]();
        await sub.remove();
        await bus.close();
      });

      it('does not try to remove anything after the connection has gone', async () => {
        const bus = sessionBus();
        await whenReady(bus);
        const sub = await bus.watch(
          `type='signal',interface='${IFACE}',member='Watched'`
        );
        await bus.close();
        // The bus dropped the rule with the connection. Reaching for it would be
        // a call on a dead socket.
        await sub.remove();
        assert.strictEqual(sub.removed, true);
      });
    });

    describe('bus.ownName()', () => {
      it('takes the name and reports being the primary owner', async () => {
        const bus = sessionBus();
        await whenReady(bus);
        const reg = await bus.ownName(NAME);

        assert.strictEqual(reg.name, NAME);
        assert.strictEqual(reg.result, 1);
        assert.strictEqual(reg.isPrimaryOwner, true);
        assert.strictEqual(await helper.nameHasOwner(NAME), true);

        await reg.release();
        await bus.close();
      });

      it('gives the name back on release', async () => {
        const bus = sessionBus();
        await whenReady(bus);
        const reg = await bus.ownName(NAME);
        await reg.release();
        assert.strictEqual(reg.released, true);
        assert.strictEqual(await helper.nameHasOwner(NAME), false);
        await bus.close();
      });

      it('reports queueing rather than throwing', async () => {
        // Not getting a name is a legitimate outcome, not an error -- a service
        // may well want to know it is the standby rather than crash.
        const first = sessionBus();
        const second = sessionBus();
        await Promise.all([whenReady(first), whenReady(second)]);

        const held = await first.ownName(NAME);
        const queued = await second.ownName(NAME);
        assert.strictEqual(queued.result, 2, 'IN_QUEUE');
        assert.strictEqual(queued.isPrimaryOwner, false);

        await queued.release();
        await held.release();
        await first.close();
        await second.close();
      });

      it('releases through Symbol.asyncDispose', async () => {
        const bus = sessionBus();
        await whenReady(bus);
        const reg = await bus.ownName(NAME);
        await reg[Symbol.asyncDispose]();
        assert.strictEqual(await helper.nameHasOwner(NAME), false);
        await bus.close();
      });
    });

    // `await using` is deliberately not written anywhere in here. The keyword
    // needs Node 24 and this package supports 20.8, so a file containing it
    // would be a *syntax* error on the older two -- before any skip could run.
    // That is the same split the library takes: it implements the protocol on
    // every supported Node, and the keyword is the consumer's choice.
    //
    // So these drive the stack by hand. What `await using` adds on top is
    // purely that the language calls disposeAsync() for you.
    describe('composed with AsyncDisposableStack', () => {
      const NO_STACK =
        typeof AsyncDisposableStack !== 'function' &&
        'AsyncDisposableStack needs a newer Node';

      it('unwinds everything in reverse', { skip: NO_STACK }, async () => {
        // The shape of a service: a connection, a name, and a subscription --
        // the try/finally pyramid this replaces is the one nobody writes.
        const stack = new AsyncDisposableStack();
        const bus = sessionBus();
        await whenReady(bus);
        stack.use(bus);
        stack.use(await bus.ownName(NAME));
        stack.use(
          await bus.watch(`type='signal',interface='${IFACE}',member='Stacked'`)
        );

        assert.strictEqual(await helper.nameHasOwner(NAME), true);

        await stack.disposeAsync();

        assert.strictEqual(bus.connection.stream.destroyed, true);
        assert.strictEqual(await helper.nameHasOwner(NAME), false);
      });

      it('unwinds through a failure', { skip: NO_STACK }, async () => {
        const stack = new AsyncDisposableStack();
        const bus = sessionBus();
        await whenReady(bus);
        stack.use(bus);
        stack.use(await bus.ownName(NAME));

        // What `await using` does when the block throws.
        try {
          throw new Error('deliberate');
        } catch (err) {
          await stack.disposeAsync();
          assert.strictEqual(err.message, 'deliberate');
        }

        assert.strictEqual(bus.connection.stream.destroyed, true);
        assert.strictEqual(await helper.nameHasOwner(NAME), false);
      });
    });
  }
);
