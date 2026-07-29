// Signal subscription on an introspected proxy.
//
// Driven through a stub bus rather than a daemon: what is under test is the
// bookkeeping between the proxy and `bus.signals`, and AddMatch failing is
// awkward to arrange for real. test/integration/signals.js covers the same
// surface end to end.

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const introspect = require('../lib/introspect');
const { ConnectionClosedError } = require('../lib/errors');

const IFACE = 'com.example.Iface';
const PATH = '/com/example/Obj';

const XML = `<node>
  <interface name="${IFACE}">
    <method name="Poke"><arg name="how" direction="in" type="s"/></method>
    <signal name="Alpha"><arg name="which" type="s"/></signal>
    <signal name="Beta"><arg name="which" type="s"/></signal>
    <signal name="Bare"/>
    <signal name="Unnamed"><arg type="s"/><arg type="i"/></signal>
    <property name="Status" type="u" access="read"/>
  </interface>
</node>`;

// A bus with just the surface the proxy touches.
function stubBus() {
  const bus = {
    signals: new EventEmitter(),
    matches: [],
    addMatchError: null,
    removeMatchError: null,
    mangle: (path, iface, member) =>
      JSON.stringify({ path, interface: iface, member }),
    addMatch(match, callback) {
      if (bus.addMatchError) return queue(callback, bus.addMatchError);
      bus.matches.push(match);
      queue(callback, null);
    },
    removeMatch(match, callback) {
      if (bus.removeMatchError) return queue(callback, bus.removeMatchError);
      bus.matches = bus.matches.filter(m => m !== match);
      queue(callback, null);
    }
  };
  return bus;
}

// Replies arrive off a socket, so never synchronously.
const queue = (callback, err) => setImmediate(() => callback(err));

const proxyFor = bus =>
  new Promise((resolve, reject) => {
    const obj = { name: PATH, service: { name: 'com.example', bus } };
    introspect.processXML(null, XML, obj, (err, proxy) =>
      err ? reject(err) : resolve(proxy[IFACE])
    );
  });

describe('proxy signals', () => {
  let bus, iface;

  beforeEach(async () => {
    bus = stubBus();
    iface = await proxyFor(bus);
  });

  const key = member => bus.mangle(PATH, IFACE, member);
  const fire = (member, body) => bus.signals.emit(key(member), body);

  describe('introspection', () => {
    it('records signals as [signature, ...argumentNames]', () => {
      assert.deepStrictEqual(iface.$signals.Alpha, ['s', 'which']);
    });

    it('records a signal with no arguments', () => {
      assert.deepStrictEqual(iface.$signals.Bare, ['']);
    });

    it('falls back to positional names when the XML omits them', () => {
      assert.deepStrictEqual(iface.$signals.Unnamed, ['si', 'arg0', 'arg1']);
    });

    it('leaves methods and properties alone', () => {
      assert.strictEqual(iface.$methods.Poke, 's');
      assert.strictEqual(iface.$properties.Status.type, 'u');
    });
  });

  describe('on', () => {
    it('delivers the signal body as arguments', async () => {
      const seen = [];
      await iface.$subscribe('Alpha', (...args) => seen.push(args));
      fire('Alpha', ['hello']);
      assert.deepStrictEqual(seen, [['hello']]);
    });

    it('adds the match rule once per signal', async () => {
      await iface.$subscribe('Alpha', () => {});
      await iface.$subscribe('Alpha', () => {});
      assert.deepStrictEqual(bus.matches, [
        `type='signal',path='${PATH}',interface='${IFACE}',member='Alpha'`
      ]);
    });

    it('returns the interface, so calls chain', () => {
      assert.strictEqual(
        iface.on('Alpha', () => {}),
        iface
      );
    });

    it('is subscribed by the time $subscribe resolves', async () => {
      let count = 0;
      await iface.$subscribe('Alpha', () => count++);
      fire('Alpha', ['x']);
      assert.strictEqual(count, 1);
    });
  });

  describe('off', () => {
    it('stops delivering', async () => {
      let count = 0;
      const cb = () => count++;
      await iface.$subscribe('Alpha', cb);
      await iface.$unsubscribe('Alpha', cb);
      fire('Alpha', ['x']);
      assert.strictEqual(count, 0);
    });

    it('removes the match rule once nothing is listening', async () => {
      const cb = () => {};
      await iface.$subscribe('Alpha', cb);
      await iface.$unsubscribe('Alpha', cb);
      assert.deepStrictEqual(bus.matches, []);
    });

    it('keeps the match rule while another listener remains', async () => {
      const cb = () => {};
      await iface.$subscribe('Alpha', cb);
      await iface.$subscribe('Alpha', () => {});
      await iface.$unsubscribe('Alpha', cb);
      assert.strictEqual(bus.matches.length, 1);
    });

    // The regression this file exists for: unsubscribing the last listener of
    // one signal used to wipe the bookkeeping for every signal on the
    // interface, so the next off() removed nothing and the listener kept
    // firing with no way to stop it.
    it('still works for one signal after another was fully removed', async () => {
      let beta = 0;
      const onAlpha = () => {};
      const onBeta = () => beta++;

      await iface.$subscribe('Alpha', onAlpha);
      await iface.$subscribe('Beta', onBeta);
      await iface.$unsubscribe('Alpha', onAlpha);
      await iface.$unsubscribe('Beta', onBeta);

      fire('Beta', ['x']);
      assert.strictEqual(beta, 0);
      assert.strictEqual(bus.signals.listenerCount(key('Beta')), 0);
      assert.deepStrictEqual(bus.matches, []);
    });

    // The same regression through on()/off(), which is what callers use and
    // what the old implementation left permanently subscribed.
    it('still works through on()/off() after another signal was removed', async () => {
      let beta = 0;
      const onAlpha = () => {};
      const onBeta = () => beta++;
      const settle = () => new Promise(resolve => setTimeout(resolve, 10));

      iface.on('Alpha', onAlpha);
      iface.on('Beta', onBeta);
      await settle();
      iface.off('Alpha', onAlpha);
      await settle();
      iface.off('Beta', onBeta);
      await settle();

      fire('Beta', ['x']);
      assert.strictEqual(beta, 0, 'off() left the listener subscribed');
      assert.strictEqual(bus.signals.listenerCount(key('Beta')), 0);
    });

    it('ignores a listener that was never subscribed', async () => {
      await iface.$unsubscribe('Alpha', () => {});
      assert.deepStrictEqual(bus.matches, []);
    });

    it('removes one registration per call when added twice', async () => {
      let count = 0;
      const cb = () => count++;
      await iface.$subscribe('Alpha', cb);
      await iface.$subscribe('Alpha', cb);
      assert.strictEqual(iface.listenerCount('Alpha'), 2);

      await iface.$unsubscribe('Alpha', cb);
      fire('Alpha', ['x']);
      assert.strictEqual(count, 1, 'added twice, removed once: still firing');

      await iface.$unsubscribe('Alpha', cb);
      fire('Alpha', ['x']);
      assert.strictEqual(count, 1);
      assert.strictEqual(bus.signals.listenerCount(key('Alpha')), 0);
    });
  });

  describe('once', () => {
    it('fires exactly once and drops the match rule', async () => {
      let count = 0;
      iface.once('Alpha', () => count++);
      await new Promise(setImmediate);

      fire('Alpha', ['x']);
      fire('Alpha', ['x']);
      assert.strictEqual(count, 1);

      await new Promise(setImmediate);
      assert.deepStrictEqual(bus.matches, []);
    });

    it('can be cancelled with the original listener', async () => {
      let count = 0;
      const cb = () => count++;
      iface.once('Alpha', cb);
      await new Promise(setImmediate);
      await iface.$unsubscribe('Alpha', cb);

      fire('Alpha', ['x']);
      assert.strictEqual(count, 0);
    });
  });

  describe('removeAllListeners', () => {
    it('removes every listener for one signal', async () => {
      await iface.$subscribe('Alpha', () => {});
      await iface.$subscribe('Alpha', () => {});
      await iface.$subscribe('Beta', () => {});

      iface.removeAllListeners('Alpha');
      await new Promise(setImmediate);

      assert.strictEqual(iface.listenerCount('Alpha'), 0);
      assert.strictEqual(iface.listenerCount('Beta'), 1);
      assert.strictEqual(bus.matches.length, 1);
    });

    it('removes every listener on the interface when given no name', async () => {
      await iface.$subscribe('Alpha', () => {});
      await iface.$subscribe('Beta', () => {});

      iface.removeAllListeners();
      await new Promise(setImmediate);

      assert.strictEqual(bus.signals.eventNames().length, 0);
      assert.deepStrictEqual(bus.matches, []);
    });
  });

  describe('when AddMatch fails', () => {
    beforeEach(() => {
      bus.addMatchError = Object.assign(new Error('denied'), {
        name: 'DBusError',
        dbusName: 'org.freedesktop.DBus.Error.AccessDenied'
      });
    });

    it('rejects with the DBusError, keeping its name', async () => {
      const err = await iface
        .$subscribe('Alpha', () => {})
        .then(
          () => null,
          e => e
        );
      assert.ok(err, 'expected $subscribe to reject');
      assert.strictEqual(
        err.dbusName,
        'org.freedesktop.DBus.Error.AccessDenied'
      );
    });

    it('leaves no listener behind on a failed subscription', async () => {
      await iface.$subscribe('Alpha', () => {}).catch(() => {});
      assert.strictEqual(bus.signals.listenerCount(key('Alpha')), 0);
      assert.strictEqual(iface.listenerCount('Alpha'), 0);
    });

    it('retries the match rule on the next subscribe', async () => {
      await iface.$subscribe('Alpha', () => {}).catch(() => {});
      bus.addMatchError = null;

      let count = 0;
      await iface.$subscribe('Alpha', () => count++);
      fire('Alpha', ['x']);
      assert.strictEqual(count, 1);
      assert.strictEqual(bus.matches.length, 1);
    });

    // Ending a connection shortly after off() is an ordinary shutdown, and
    // RemoveMatch losing the race with the close used to reach the "nobody is
    // listening, so rethrow" path and take the process down -- intermittently,
    // which is how it showed up: one CI leg out of six.
    it('stays quiet when the match call fails because the connection closed', async () => {
      const quiet = stubBus();
      const ifaceQuiet = await proxyFor(quiet);
      const connection = new EventEmitter();
      quiet.connection = connection;
      const reported = [];
      connection.on('handlerError', e => reported.push(e));

      const thrown = [];
      const onUncaught = e => thrown.push(e);
      process.on('uncaughtException', onUncaught);

      quiet.addMatchError = new ConnectionClosedError({});
      ifaceQuiet.on('Alpha', () => {});
      await new Promise(setImmediate);

      quiet.addMatchError = null;
      quiet.removeMatchError = new ConnectionClosedError({});
      const cb = () => {};
      await ifaceQuiet.$subscribe('Beta', cb);
      ifaceQuiet.off('Beta', cb);
      await new Promise(setImmediate);

      process.removeListener('uncaughtException', onUncaught);
      assert.deepStrictEqual(
        reported,
        [],
        'nothing to report on a dead connection'
      );
      assert.deepStrictEqual(thrown, [], 'and nothing rethrown');
    });

    it('still reports a match failure that is not the connection closing', async () => {
      const connection = new EventEmitter();
      bus.connection = connection;
      const errors = [];
      connection.on('handlerError', e => errors.push(e));

      iface.on('Alpha', () => {});
      await new Promise(setImmediate);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(
        errors[0].dbusName,
        'org.freedesktop.DBus.Error.AccessDenied'
      );
    });

    it('reports through the connection rather than throwing, via on()', async () => {
      const connection = new EventEmitter();
      bus.connection = connection;
      const errors = [];
      connection.on('handlerError', e => errors.push(e));

      iface.on('Alpha', () => {});
      await new Promise(setImmediate);

      assert.strictEqual(errors.length, 1);
      assert.strictEqual(
        errors[0].dbusName,
        'org.freedesktop.DBus.Error.AccessDenied'
      );
    });
  });
});
