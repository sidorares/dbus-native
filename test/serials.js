// Message serials.
//
// A serial is a uint32 in the header. It used to be a bare `++` with nothing
// to stop it, so a long-lived connection eventually rejected every outgoing
// message with 'Number outside range' -- about fifty days at a thousand
// messages a second.

const { describe, it } = require('node:test');
const assert = require('assert');
const { Duplex } = require('stream');
const dbus = require('../index');
const message = require('../lib/message');

class FakeSocket extends Duplex {
  constructor() {
    super();
    this.written = [];
  }
  _write(chunk, enc, cb) {
    this.written.push(chunk);
    cb();
  }
  _read() {}
}

function connectBus() {
  return new Promise(resolve => {
    const socket = new FakeSocket();
    const bus = dbus.createClient({ stream: socket, direct: true });
    setImmediate(() => socket.push('OK 0123456789abcdef\r\n'));
    bus.connection.once('connect', () => resolve({ bus, socket }));
  });
}

const ifaceDesc = {
  name: 'com.example.Iface',
  methods: {},
  signals: { Pinged: ['s', 'who'] },
  properties: {}
};

describe('message serials', () => {
  it('starts at 1 and goes up by one', async () => {
    const { bus } = await connectBus();
    assert.strictEqual(bus.nextSerial(), 1);
    assert.strictEqual(bus.nextSerial(), 2);
    assert.strictEqual(bus.nextSerial(), 3);
    bus.connection.end();
  });

  it('wraps at the uint32 ceiling rather than overflowing', async () => {
    const { bus } = await connectBus();
    bus.serial = 0xfffffffe;
    assert.strictEqual(bus.nextSerial(), 0xfffffffe);
    assert.strictEqual(bus.nextSerial(), 0xffffffff);
    // 0 is not a valid serial, so the wrap goes to 1
    assert.strictEqual(bus.nextSerial(), 1);
    assert.strictEqual(bus.nextSerial(), 2);
    bus.connection.end();
  });

  it('a wrapped serial still marshals', async () => {
    const { bus } = await connectBus();
    bus.serial = 0xffffffff;
    const serial = bus.nextSerial();
    assert.doesNotThrow(() =>
      message.marshall({
        type: 1,
        serial,
        destination: 'com.example.Svc',
        path: '/com/example/Svc',
        interface: 'com.example.Iface',
        member: 'Ping'
      })
    );
    bus.connection.end();
  });

  it('the value that used to be reached would not marshal', () => {
    // What the old bare `++` produced one message after 0xffffffff.
    assert.throws(
      () =>
        message.marshall({
          type: 1,
          serial: 0x100000000,
          destination: 'com.example.Svc',
          path: '/com/example/Svc',
          interface: 'com.example.Iface',
          member: 'Ping'
        }),
      /Number outside range/
    );
  });

  // exportInterface's patched emit() took a serial for the message and then
  // incremented again, so every signal burned two and halved the time to the
  // ceiling.
  it('an exported signal consumes exactly one serial', async () => {
    const { bus } = await connectBus();
    const { EventEmitter } = require('events');
    const impl = Object.assign(Object.create(EventEmitter.prototype), {});
    EventEmitter.call(impl);
    bus.exportInterface(impl, '/com/example/Obj', ifaceDesc);

    const before = bus.serial;
    impl.emit('Pinged', 'someone');
    assert.strictEqual(bus.serial - before, 1);

    impl.emit('Pinged', 'again');
    assert.strictEqual(bus.serial - before, 2);
    bus.connection.end();
  });

  it('emitting a signal the interface does not declare takes no serial', async () => {
    const { bus } = await connectBus();
    const { EventEmitter } = require('events');
    const impl = Object.assign(Object.create(EventEmitter.prototype), {});
    EventEmitter.call(impl);
    bus.exportInterface(impl, '/com/example/Obj2', ifaceDesc);

    const before = bus.serial;
    impl.emit('NotDeclared', 'x'); // stays local
    assert.strictEqual(bus.serial, before);
    bus.connection.end();
  });

  it('a method call takes exactly one serial', async () => {
    const { bus } = await connectBus();
    const before = bus.serial;
    bus.invoke({
      destination: 'com.example.Svc',
      path: '/com/example/Svc',
      interface: 'com.example.Iface',
      member: 'Ping'
    });
    assert.strictEqual(bus.serial - before, 1);
    bus.connection.end();
  });
});
