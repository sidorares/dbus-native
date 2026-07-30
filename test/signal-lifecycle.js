// A signal is emitted by emitting an ordinary event on the exported object, so
// `emit` is wrapped. The wrapper has to follow the export: one per object
// rather than one per exportInterface call, and gone once the object is no
// longer exported.

const { describe, it } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const MessageBus = require('../lib/bus');

const IFACE = 'com.example.Iface';

const ifaceDesc = (name = IFACE) => ({
  name,
  methods: {},
  signals: { Pinged: ['s'], Other: ['s'] },
  properties: {}
});

function fixture() {
  const conn = new EventEmitter();
  const sent = [];
  conn.message = msg => sent.push(msg);
  const bus = new MessageBus(conn, { direct: true });
  return {
    bus,
    obj: new EventEmitter(),
    /** The signals emitted since the last call, then reset. */
    drain(member = 'Pinged') {
      const out = sent.filter(m => m.member === member);
      sent.length = 0;
      return out;
    }
  };
}

describe('an exported signal goes out once per export', () => {
  it('once for one export', () => {
    const { bus, obj, drain } = fixture();
    bus.exportInterface(obj, '/p', ifaceDesc());
    obj.emit('Pinged', 'a');
    assert.strictEqual(drain().length, 1);
  });

  // The regression: exportInterface wrapped `emit` every time it was called,
  // so a second export of the same interface put a second wrapper on top and
  // every signal went out twice.
  it('still once when the same interface is exported again', () => {
    const { bus, obj, drain } = fixture();
    bus.exportInterface(obj, '/p', ifaceDesc());
    bus.exportInterface(obj, '/p', ifaceDesc());
    obj.emit('Pinged', 'a');
    assert.strictEqual(drain().length, 1);
  });

  it('once per path when the object is exported at two', () => {
    const { bus, obj, drain } = fixture();
    bus.exportInterface(obj, '/p', ifaceDesc());
    bus.exportInterface(obj, '/q', ifaceDesc());
    drain(); // clear the InterfacesAdded traffic
    obj.emit('Pinged', 'a');
    assert.deepStrictEqual(
      drain()
        .map(m => m.path)
        .sort(),
      ['/p', '/q']
    );
  });

  it('once per interface when an object serves two that declare it', () => {
    const { bus, obj, drain } = fixture();
    bus.exportInterface(obj, '/p', ifaceDesc('com.example.One'));
    bus.exportInterface(obj, '/p', ifaceDesc('com.example.Two'));
    obj.emit('Pinged', 'a');
    assert.deepStrictEqual(
      drain()
        .map(m => m.interface)
        .sort(),
      ['com.example.One', 'com.example.Two']
    );
  });

  it('carries the signature and body', () => {
    const { bus, obj, drain } = fixture();
    bus.exportInterface(obj, '/p', ifaceDesc());
    obj.emit('Pinged', 'hello');
    const [signal] = drain();
    assert.strictEqual(signal.signature, 's');
    assert.deepStrictEqual(signal.body, ['hello']);
  });

  it('says so when asked to emit nothing', () => {
    const { bus, obj } = fixture();
    bus.exportInterface(obj, '/p', ifaceDesc());
    assert.throws(() => obj.emit(''), /Trying to emit undefined signal/);
  });
});

describe('and stops when the export does', () => {
  // The regression: nothing ever removed the wrapper, so an object went on
  // putting signals on the wire for an interface it no longer served.
  it('no signal after the interface is unexported', () => {
    const { bus, obj, drain } = fixture();
    bus.exportInterface(obj, '/p', ifaceDesc());
    bus.unexportInterface('/p', IFACE);
    obj.emit('Pinged', 'a');
    assert.deepStrictEqual(drain(), []);
  });

  it('no signal after the whole path is unexported', () => {
    const { bus, obj, drain } = fixture();
    bus.exportInterface(obj, '/p', ifaceDesc());
    bus.unexportInterface('/p');
    obj.emit('Pinged', 'a');
    assert.deepStrictEqual(drain(), []);
  });

  it('the other path keeps working when one is unexported', () => {
    const { bus, obj, drain } = fixture();
    bus.exportInterface(obj, '/p', ifaceDesc());
    bus.exportInterface(obj, '/q', ifaceDesc());
    bus.unexportInterface('/q', IFACE);
    obj.emit('Pinged', 'a');
    assert.deepStrictEqual(
      drain().map(m => m.path),
      ['/p']
    );
  });

  it('gives the object its own emit back once nothing is exported', () => {
    const { bus, obj } = fixture();
    const original = obj.emit;
    bus.exportInterface(obj, '/p', ifaceDesc());
    assert.notStrictEqual(obj.emit, original, 'wrapped while exported');
    bus.unexportInterface('/p', IFACE);
    assert.strictEqual(obj.emit, original, 'and given back afterwards');
  });

  it('can be exported again afterwards', () => {
    const { bus, obj, drain } = fixture();
    bus.exportInterface(obj, '/p', ifaceDesc());
    bus.unexportInterface('/p', IFACE);
    bus.exportInterface(obj, '/p', ifaceDesc());
    obj.emit('Pinged', 'a');
    assert.strictEqual(drain().length, 1);
  });

  it('leaves a wrapper somebody else added on top alone', () => {
    const { bus, obj, drain } = fixture();
    bus.exportInterface(obj, '/p', ifaceDesc());
    let seen = 0;
    const ours = obj.emit;
    obj.emit = function (...args) {
      seen++;
      return ours.apply(this, args);
    };
    bus.unexportInterface('/p', IFACE);
    obj.emit('Pinged', 'a');
    assert.strictEqual(seen, 1, "the caller's own wrapper still runs");
    assert.deepStrictEqual(drain(), [], 'but no signal goes out');
  });
});

describe('the local listener is unaffected throughout', () => {
  it('still hears the event, with its arguments', () => {
    const { bus, obj } = fixture();
    const heard = [];
    obj.on('Pinged', arg => heard.push(arg));
    bus.exportInterface(obj, '/p', ifaceDesc());
    obj.emit('Pinged', 'a');
    bus.unexportInterface('/p', IFACE);
    obj.emit('Pinged', 'b');
    assert.deepStrictEqual(heard, ['a', 'b']);
  });

  it('emit still reports whether anyone was listening', () => {
    const { bus, obj } = fixture();
    bus.exportInterface(obj, '/p', ifaceDesc());
    assert.strictEqual(obj.emit('Pinged', 'a'), false, 'nobody listening');
    obj.on('Pinged', () => {});
    assert.strictEqual(obj.emit('Pinged', 'a'), true, 'somebody listening');
  });
});
