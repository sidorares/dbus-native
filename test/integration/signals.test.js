// Test that signals emit correctly

let dbus = require('../../');
let Variant = dbus.Variant;
let MethodError = dbus.MethodError;

let {
  Interface,
  property,
  method,
  signal,
  ACCESS_READ,
  ACCESS_WRITE,
  ACCESS_READWRITE
} = dbus.interface;

const TEST_NAME = 'org.test.name';
const TEST_PATH = '/org/test/path';
const TEST_IFACE = 'org.test.iface';

let bus = dbus.sessionBus();

class SignalsInterface extends Interface {
  @signal({ signature: 's' })
  HelloWorld(value) {
    return value;
  }

  @signal({ signature: 'ss' })
  SignalMultiple() {
    return ['hello', 'world'];
  }

  // a really complicated variant
  complicated = new Variant('a{sv}', {
    foo: new Variant('s', 'bar'),
    bar: new Variant('d', 53),
    bat: new Variant('v', new Variant('as', ['foo', 'bar', 'bat'])),
    baz: new Variant('(doodoo)', [1, '/', '/', 1, '/', '/']),
    fiz: new Variant('(as(s(v)))', [
      ['one', 'two'],
      ['three', [new Variant('as', ['four', 'five'])]]
    ]),
    buz: new Variant('av', [
      new Variant('as', ['foo']),
      new Variant('a{ss}', { foo: 'bar' }),
      new Variant('v', new Variant('(asas)', [['bar'], ['foo']])),
      new Variant('v', new Variant('v', new Variant('as', ['one', 'two']))),
      new Variant('a{ss}', { foo: 'bar' })
    ])
  });

  @signal({ signature: 'v' })
  SignalComplicated() {
    return this.complicated;
  }

  @method({ inSignature: '', outSignature: '' })
  EmitSignals() {
    this.HelloWorld('hello');
    this.SignalMultiple();
    this.SignalComplicated();
  }
}

let testIface = new SignalsInterface(TEST_IFACE);

beforeAll(async () => {
  await bus.export(TEST_NAME, TEST_PATH, testIface);
});

afterAll(() => {
  bus.connection.stream.end();
});

test('test that signals work correctly', async () => {
  let object = await bus.getProxyObject(TEST_NAME, TEST_PATH);
  let test = object.getInterface(TEST_IFACE);

  let onHelloWorld = jest.fn(() => {});
  let onSignalMultiple = jest.fn(() => {});
  let onSignalComplicated = jest.fn(() => {});

  test.on('HelloWorld', onHelloWorld);
  test.on('SignalMultiple', onSignalMultiple);
  test.on('SignalComplicated', onSignalComplicated);

  await test.EmitSignals();

  expect(onHelloWorld).toHaveBeenCalledWith('hello');
  expect(onSignalMultiple).toHaveBeenCalledWith('hello', 'world');
  expect(onSignalComplicated).toHaveBeenCalledWith(testIface.complicated);
});
