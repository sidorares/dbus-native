// End-to-end tests against a real dbus-daemon.
//
// Run with `npm run test:integration`, which starts a private session bus and
// exports DBUS_SESSION_BUS_ADDRESS for us.

const assert = require('assert');
const dbus = require('../../index');

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

describe('integration: real session bus', function () {
  this.timeout(10000);

  let serviceBus;
  let clientBus;
  let impl;

  before(function (done) {
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
      return this.skip();
    }
    serviceBus = dbus.sessionBus();
    clientBus = dbus.sessionBus();
    impl = makeImpl();

    serviceBus.requestName(SERVICE, 0, err => {
      if (err) return done(err);
      serviceBus.exportInterface(impl, OBJECT_PATH, ifaceDesc);
      done();
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

  it('lists the well-known bus name we requested', done => {
    clientBus.listNames((err, names) => {
      if (err) return done(err);
      assert.ok(names.includes(SERVICE), `${SERVICE} missing from ListNames`);
      done();
    });
  });

  it('round-trips a method call with a string argument', done => {
    clientBus.invoke(
      {
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: IFACE,
        member: 'Echo',
        signature: 's',
        body: ['round trip']
      },
      (err, result) => {
        if (err) return done(err);
        assert.strictEqual(result, 'round trip');
        done();
      }
    );
  });

  it('round-trips a method call with numeric arguments', done => {
    clientBus.invoke(
      {
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: IFACE,
        member: 'Add',
        signature: 'ii',
        body: [40, 2]
      },
      (err, result) => {
        if (err) return done(err);
        assert.strictEqual(result, 42);
        done();
      }
    );
  });

  it('propagates errors thrown by the service', done => {
    clientBus.invoke(
      {
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: IFACE,
        member: 'Fail'
      },
      err => {
        assert.ok(err, 'expected an error');
        done();
      }
    );
  });

  it('reads a property via org.freedesktop.DBus.Properties', done => {
    clientBus.invoke(
      {
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: 'org.freedesktop.DBus.Properties',
        member: 'Get',
        signature: 'ss',
        body: [IFACE, 'Greeting']
      },
      (err, result) => {
        if (err) return done(err);
        // a variant unmarshalls as [signatureTree, [value]]
        assert.strictEqual(result[1][0], 'hello');
        done();
      }
    );
  });

  it('writes a property via org.freedesktop.DBus.Properties', done => {
    clientBus.invoke(
      {
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: 'org.freedesktop.DBus.Properties',
        member: 'Set',
        signature: 'ssv',
        body: [IFACE, 'Greeting', ['s', 'updated']]
      },
      err => {
        if (err) return done(err);
        assert.strictEqual(impl.Greeting, 'updated');
        done();
      }
    );
  });

  it('errors on an unknown property', done => {
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
        assert.ok(err, 'expected an error for an unknown property');
        done();
      }
    );
  });

  it('lists all properties via GetAll', done => {
    clientBus.invoke(
      {
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: 'org.freedesktop.DBus.Properties',
        member: 'GetAll',
        signature: 's',
        body: [IFACE]
      },
      (err, result) => {
        if (err) return done(err);
        const names = result.map(entry => entry[0]);
        assert.ok(names.includes('Greeting'));
        assert.ok(names.includes('Count'));
        done();
      }
    );
  });

  it('answers org.freedesktop.DBus.Peer.GetMachineId with a real id', done => {
    clientBus.invoke(
      {
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: 'org.freedesktop.DBus.Peer',
        member: 'GetMachineId'
      },
      (err, id) => {
        if (err) return done(err);
        assert.ok(/^[0-9a-f]{32}$/.test(id), `unexpected machine id: ${id}`);
        done();
      }
    );
  });

  it('introspects the exported interface', done => {
    clientBus.invoke(
      {
        destination: SERVICE,
        path: OBJECT_PATH,
        interface: 'org.freedesktop.DBus.Introspectable',
        member: 'Introspect'
      },
      (err, xml) => {
        if (err) return done(err);
        assert.ok(xml.includes(`<interface name="${IFACE}">`));
        assert.ok(xml.includes('<method name="Echo">'));
        assert.ok(xml.includes('<signal name="Pinged">'));
        done();
      }
    );
  });

  it('delivers signals to a subscriber', done => {
    const match = `type='signal',path='${OBJECT_PATH}',interface='${IFACE}',member='Pinged'`;
    clientBus.addMatch(match, err => {
      if (err) return done(err);
      const key = clientBus.mangle(OBJECT_PATH, IFACE, 'Pinged');
      clientBus.signals.once(key, body => {
        assert.deepStrictEqual(body, ['ping payload']);
        done();
      });
      impl.emit('Pinged', 'ping payload');
    });
  });
});
