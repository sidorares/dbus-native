// Two ways a bus could be left in a state it never agreed to: constructed
// without the options it was handed, and dispatched into by a peer using a
// path that names something on Object.prototype.
//
// Both found by auditing the @homebridge/dbus-native fork.

const { describe, it } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const MessageBus = require('../lib/bus');
const constants = require('../lib/constants');

function fakeConn() {
  const conn = new EventEmitter();
  conn.sent = [];
  conn.message = msg => conn.sent.push(msg);
  return conn;
}

const methodCall = (path, iface) => ({
  type: constants.messageType.methodCall,
  path,
  interface: iface,
  member: 'AnyMember',
  serial: 1,
  signature: '',
  body: []
});

describe('a bus keeps the options it was given', () => {
  it('forwards opts when called without new', () => {
    const conn = fakeConn();
    // `direct: true` is the observable one: without it the bus opens by
    // sending Hello, which is wrong on a peer-to-peer connection.
    MessageBus(conn, { direct: true });
    assert.deepStrictEqual(
      conn.sent.map(m => m.member),
      [],
      'a direct bus should not send Hello'
    );
  });

  it('sends Hello when it really is not direct', () => {
    const conn = fakeConn();
    MessageBus(conn, {});
    assert.deepStrictEqual(
      conn.sent.map(m => m.member),
      ['Hello']
    );
  });

  it('is the same bus either way', () => {
    const conn = fakeConn();
    const made = MessageBus(conn, { direct: true });
    assert.ok(made instanceof MessageBus);
  });
});

describe('a method call cannot reach Object.prototype', () => {
  it('exportedObjects inherits nothing', () => {
    const bus = new MessageBus(fakeConn(), { direct: true });
    assert.strictEqual(Object.getPrototypeOf(bus.exportedObjects), null);
  });

  it('a per-path interface map inherits nothing either', () => {
    const bus = new MessageBus(fakeConn(), { direct: true });
    bus.exportInterface(new EventEmitter(), '/p', {
      name: 'a.b.C',
      methods: {},
      signals: {},
      properties: {}
    });
    assert.strictEqual(Object.getPrototypeOf(bus.exportedObjects['/p']), null);
  });

  // The regression: `exportedObjects['__proto__']` used to be Object.prototype
  // -- truthy -- so dispatch went on to read `['constructor']` off it, take
  // element [1] of the Object constructor (undefined), and look up a member on
  // that. One method call from any peer and the process was gone.
  for (const [path, iface] of [
    ['__proto__', 'constructor'],
    ['__proto__', '__proto__'],
    ['constructor', 'toString'],
    ['valueOf', 'hasOwnProperty']
  ]) {
    it(`answers rather than throwing for path=${path} interface=${iface}`, () => {
      const conn = fakeConn();
      const bus = new MessageBus(conn, { direct: true });
      assert.doesNotThrow(() => conn.emit('message', methodCall(path, iface)));
      assert.strictEqual(conn.sent.length, 1, 'the caller gets a reply');
      assert.strictEqual(conn.sent[0].type, constants.messageType.error);
      void bus;
    });
  }

  it('still serves an object that really is exported', () => {
    const conn = fakeConn();
    const bus = new MessageBus(conn, { direct: true });
    const impl = Object.assign(Object.create(EventEmitter.prototype), {
      Ping: () => 'pong'
    });
    EventEmitter.call(impl);
    bus.exportInterface(impl, '/p', {
      name: 'a.b.C',
      methods: { Ping: ['', 's', [], ['out']] },
      signals: {},
      properties: {}
    });
    conn.emit('message', {
      ...methodCall('/p', 'a.b.C'),
      member: 'Ping'
    });
    return new Promise(resolve =>
      setImmediate(() => {
        assert.deepStrictEqual(conn.sent[0].body, ['pong']);
        resolve();
      })
    );
  });
});
