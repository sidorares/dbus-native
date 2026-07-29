// End-to-end tests against a real dbus-daemon.
//
// Run with `npm run test:integration`, which starts a private session bus and
// exports DBUS_SESSION_BUS_ADDRESS for us.
//
// These use the callback form deliberately: `(err, result)` is public API, so
// something has to keep exercising it.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { variantValue, toPlain } = require('../../lib/values');
const { sessionBus } = require('../utils/shape');

// node:test skips a whole suite from its options, evaluated at load time.
const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Test';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/Test';
const IFACE = 'com.github.sidorares.dbusnative.TestIface';

const ifaceDesc = {
  name: IFACE,
  methods: {
    Echo: ['s', 's', ['input'], ['output']],
    Add: ['ii', 'i', ['a', 'b'], ['sum']],
    Fail: ['', '', [], []]
  },
  signals: {
    Pinged: ['s', 'payload']
  },
  properties: {
    Greeting: 's',
    Count: 'u'
  }
};

function makeImpl() {
  const impl = {
    Greeting: 'hello',
    Count: 7,
    Echo: input => input,
    Add: (a, b) => a + b,
    Fail: () => {
      const err = new Error('intentional failure');
      err.dbusName = 'com.github.sidorares.dbusnative.Error.Boom';
      throw err;
    }
  };
  // exportInterface monkey-patches emit() to also send the signal on the bus
  const { EventEmitter } = require('events');
  Object.setPrototypeOf(impl, EventEmitter.prototype);
  EventEmitter.call(impl);
  return impl;
}

/**
 * Turn an invoke callback into a passing or failing test.
 *
 * node:test cannot see a throw from inside a callback it did not call, so a
 * failed assertion in there becomes an uncaughtException and takes down the
 * whole file. One bad assertion used to report as eight failures plus a ten
 * second timeout, which buries the one that matters.
 */
const check = (done, assertions) =>
  function reply(err, ...values) {
    if (err) return done(err);
    try {
      assertions.apply(this, values);
      done();
    } catch (failure) {
      done(failure);
    }
  };

describe(
  'integration: real session bus',
  { timeout: 10000, skip: NO_BUS },
  () => {
    let serviceBus;
    let clientBus;
    let impl;

    // `bus.name` is only populated once the reply to the initial Hello arrives.
    // Replies come back in order, so round-tripping any call is enough to know
    // Hello (serial 1) has already been handled.
    const whenReady = bus =>
      new Promise((resolve, reject) => {
        bus.getId(err => (err ? reject(err) : resolve()));
      });

    before(async () => {
      serviceBus = sessionBus();
      clientBus = sessionBus();
      impl = makeImpl();

      await Promise.all([whenReady(serviceBus), whenReady(clientBus)]);

      await new Promise((resolve, reject) => {
        serviceBus.requestName(SERVICE, 0, err => {
          if (err) return reject(err);
          serviceBus.exportInterface(impl, OBJECT_PATH, ifaceDesc);
          resolve();
        });
      });
    });

    after(() => {
      if (serviceBus) serviceBus.connection.end();
      if (clientBus) clientBus.connection.end();
    });

    it('connects and gets a unique name from the bus', () => {
      assert.ok(
        /^:\d+\.\d+$/.test(clientBus.name),
        `expected a unique bus name, got ${clientBus.name}`
      );
    });

    it('lists the well-known bus name we requested', (t, done) => {
      clientBus.listNames(
        check(done, names =>
          assert.ok(
            names.includes(SERVICE),
            `${SERVICE} missing from ListNames`
          )
        )
      );
    });

    it('round-trips a method call with a string argument', (t, done) => {
      clientBus.invoke(
        {
          destination: SERVICE,
          path: OBJECT_PATH,
          interface: IFACE,
          member: 'Echo',
          signature: 's',
          body: ['round trip']
        },
        check(done, result => assert.strictEqual(result, 'round trip'))
      );
    });

    it('round-trips a method call with numeric arguments', (t, done) => {
      clientBus.invoke(
        {
          destination: SERVICE,
          path: OBJECT_PATH,
          interface: IFACE,
          member: 'Add',
          signature: 'ii',
          body: [40, 2]
        },
        check(done, result => assert.strictEqual(result, 42))
      );
    });

    it('propagates errors thrown by the service', (t, done) => {
      clientBus.invoke(
        {
          destination: SERVICE,
          path: OBJECT_PATH,
          interface: IFACE,
          member: 'Fail'
        },
        err => done(err ? undefined : new Error('expected an error'))
      );
    });

    it('reads a property via org.freedesktop.DBus.Properties', (t, done) => {
      clientBus.invoke(
        {
          destination: SERVICE,
          path: OBJECT_PATH,
          interface: 'org.freedesktop.DBus.Properties',
          member: 'Get',
          signature: 'ss',
          body: [IFACE, 'Greeting']
        },
        // A variant unmarshals as [signatureTree, [value]] classically and as
        // the value itself under `plainValues`; variantValue() reads both.
        check(done, result => assert.strictEqual(variantValue(result), 'hello'))
      );
    });

    it('writes a property via org.freedesktop.DBus.Properties', (t, done) => {
      clientBus.invoke(
        {
          destination: SERVICE,
          path: OBJECT_PATH,
          interface: 'org.freedesktop.DBus.Properties',
          member: 'Set',
          signature: 'ssv',
          body: [IFACE, 'Greeting', ['s', 'updated']]
        },
        check(done, () => assert.strictEqual(impl.Greeting, 'updated'))
      );
    });

    it('errors on an unknown property', (t, done) => {
      clientBus.invoke(
        {
          destination: SERVICE,
          path: OBJECT_PATH,
          interface: 'org.freedesktop.DBus.Properties',
          member: 'Get',
          signature: 'ss',
          body: [IFACE, 'NoSuchProperty']
        },
        err => {
          if (!err) return done(new Error('expected an error'));
          done();
        }
      );
    });

    it('lists all properties via GetAll', (t, done) => {
      clientBus.invoke(
        {
          destination: SERVICE,
          path: OBJECT_PATH,
          interface: 'org.freedesktop.DBus.Properties',
          member: 'GetAll',
          signature: 's',
          body: [IFACE]
        },
        check(done, result => {
          // Pairs classically, a plain object under `plainValues`.
          const names = Object.keys(toPlain(result));
          assert.ok(names.includes('Greeting'));
          assert.ok(names.includes('Count'));
        })
      );
    });

    it('answers org.freedesktop.DBus.Peer.GetMachineId with a real id', (t, done) => {
      clientBus.invoke(
        {
          destination: SERVICE,
          path: OBJECT_PATH,
          interface: 'org.freedesktop.DBus.Peer',
          member: 'GetMachineId'
        },
        check(done, id =>
          assert.ok(/^[0-9a-f]{32}$/.test(id), `unexpected machine id: ${id}`)
        )
      );
    });

    it('introspects the exported interface', (t, done) => {
      clientBus.invoke(
        {
          destination: SERVICE,
          path: OBJECT_PATH,
          interface: 'org.freedesktop.DBus.Introspectable',
          member: 'Introspect'
        },
        check(done, xml => {
          assert.ok(xml.includes(`<interface name="${IFACE}">`));
          assert.ok(xml.includes('<method name="Echo">'));
          assert.ok(xml.includes('<signal name="Pinged">'));
        })
      );
    });

    it('delivers signals to a subscriber', (t, done) => {
      const match = `type='signal',path='${OBJECT_PATH}',interface='${IFACE}',member='Pinged'`;
      clientBus.addMatch(match, err => {
        if (err) return done(err);
        const key = clientBus.mangle(OBJECT_PATH, IFACE, 'Pinged');
        // A signal handler takes the body, not (err, result), so it gets the
        // same try/catch by hand rather than through check().
        clientBus.signals.once(key, body => {
          try {
            assert.deepStrictEqual(body, ['ping payload']);
            done();
          } catch (failure) {
            done(failure);
          }
        });
        impl.emit('Pinged', 'ping payload');
      });
    });
  }
);
