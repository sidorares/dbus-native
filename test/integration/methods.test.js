// Test that interface methods work correctly

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

class MethodsInterface extends Interface {
  @method({ inSignature: 'v', outSignature: 'v' })
  Echo(what) {
    return what;
  }

  @method({ inSignature: 'vv', outSignature: 'vv' })
  EchoMultiple(what, what2) {
    return [what, what2];
  }

  @method({ inSignature: '', outSignature: '' })
  ThrowsError() {
    throw new MethodError('org.test.iface.Error', 'something went wrong');
  }

  complicated1 = [
    new Variant('s', 'foo'),
    new Variant('(s(sv))', [
      'bar',
      [
        'bat',
        new Variant('av', [new Variant('s', 'baz'), new Variant('i', 53)])
      ]
    ])
  ];

  complicated2 = ['one', 'two'];

  @method({ inSignature: '', outSignature: 'av(ss)' })
  ReturnsComplicated() {
    return [this.complicated1, this.complicated2];
  }

  @method({ inSignature: 'as', outSignature: '' })
  TakesList() {}
}

let testIface = new MethodsInterface(TEST_IFACE);

beforeAll(async () => {
  await bus.export(TEST_NAME, TEST_PATH, testIface);
});

afterAll(() => {
  bus.connection.stream.end();
});

// a really complicated variant
let echoVariant = new Variant('a{sv}', {
  foo: new Variant('s', 'bar'),
  bar: new Variant('d', 53),
  bat: new Variant('v', new Variant('as', ['foo', 'bar', 'bat'])),
  baz: new Variant('(doodoo)', [1, '/', '/', 1, '/', '/']),
  fiz: new Variant('(as(s(v)))', [
    ['one', 'two'],
    ['three', [new Variant('as', ['four', 'five'])]]
  ]),
  kevin: new Variant('(vs)', [new Variant('s', 'foo'), 'foo']),
  buz: new Variant('av', [
    new Variant('as', ['foo']),
    new Variant('a{ss}', { foo: 'bar' }),
    new Variant('v', new Variant('(asas)', [['bar'], ['foo']])),
    new Variant('v', new Variant('v', new Variant('as', ['one', 'two']))),
    new Variant('a{ss}', { foo: 'bar' })
  ])
});

test('test that methods work correctly', async () => {
  let object = await bus.getProxyObject(TEST_NAME, TEST_PATH);
  let test = object.getInterface(TEST_IFACE);

  let result = await test.Echo(echoVariant);
  expect(result).toEqual(echoVariant);

  let [r1, r2] = await test.EchoMultiple(echoVariant, echoVariant);
  expect(r1).toEqual(echoVariant);
  expect(r2).toEqual(echoVariant);

  [r1, r2] = await test.ReturnsComplicated();
  expect(r1).toEqual(testIface.complicated1);
  expect(r2).toEqual(testIface.complicated2);

  let req = test.ThrowsError();
  let expected = new MethodError(
    'org.test.iface.Error',
    'something went wrong'
  );
  await expect(req).rejects.toEqual(expected);
});

test('test client method errors', async () => {
  let object = await bus.getProxyObject(TEST_NAME, TEST_PATH);
  let test = object.getInterface(TEST_IFACE);

  await expect(test.Echo('wrong type')).rejects.toBeInstanceOf(Error);
  await expect(test.TakesList('wrong type')).rejects.toBeInstanceOf(Error);
  await expect(test.TakesList()).rejects.toBeInstanceOf(Error);
  await expect(
    test.Echo(new Variant('as', 'wrong type'))
  ).rejects.toBeInstanceOf(Error);
});
