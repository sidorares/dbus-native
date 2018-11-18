// Test the server properties interface works correctly.

let dbus = require('../../');
let Variant = dbus.Variant;

let {
  Interface,
  property,
  method,
  signal,
  MethodError,
  ACCESS_READ,
  ACCESS_WRITE,
  ACCESS_READWRITE
} = dbus.interface;

const TEST_NAME = 'org.test.name';
const TEST_PATH = '/org/test/path';
const TEST_IFACE = 'org.test.iface';
const INVALID_ARGS = 'org.freedesktop.DBus.Error.InvalidArgs';

let bus = dbus.sessionBus();

class TestInterface extends Interface {
  constructor(name) {
    super(name);
  }

  @property({ signature: 's' })
  SimpleProperty = 'foo';

  @property({ signature: 'v' })
  VariantProperty = new Variant('s', 'foo');

  @property({ signature: '(a{sv}sv)' })
  ComplicatedProperty = [
    {
      foo: new Variant('s', 'bar'),
      bar: new Variant('as', ['fiz', 'buz'])
    },
    'bat',
    new Variant('d', 53)
  ];

  _NotifyingProperty = 'foo';

  @property({ signature: 's' })
  get NotifyingProperty() {
    return this._NotifyingProperty;
  }
  set NotifyingProperty(value) {
    this._NotifyingProperty = value;
    this.PropertiesChanged(
      {
        NotifyingProperty: value
      },
      ['invalid']
    );
  }

  @property({ signature: 's', access: ACCESS_READ })
  ReadOnly = 'only read';

  @property({ signature: 's', access: ACCESS_WRITE })
  WriteOnly = 'only write';
}

let testIface = new TestInterface(TEST_IFACE);

beforeAll(async () => {
  await bus.export(TEST_NAME, TEST_PATH, testIface);
});

afterAll(() => {
  bus.connection.stream.end();
});

test('test simple property get and set', async () => {
  let object = await bus.getProxyObject(TEST_NAME, TEST_PATH);

  let test = object.getInterface(TEST_IFACE);
  expect(test).toBeDefined();
  let properties = object.getInterface('org.freedesktop.DBus.Properties');
  expect(properties).toBeDefined();

  // get and set a simple property
  let prop = await properties.Get(TEST_IFACE, 'SimpleProperty');
  expect(prop).toBeInstanceOf(Variant);
  expect(prop.signature).toEqual('s');
  expect(prop.value).toEqual('foo');
  expect(prop.value).toEqual(testIface.SimpleProperty);

  await properties.Set(TEST_IFACE, 'SimpleProperty', new Variant('s', 'bar'));

  prop = await properties.Get(TEST_IFACE, 'SimpleProperty');
  expect(prop).toBeInstanceOf(Variant);
  expect(prop.value).toEqual('bar');
  expect(prop.value).toEqual(testIface.SimpleProperty);

  // get and set a variant property
  prop = await properties.Get(TEST_IFACE, 'VariantProperty');
  expect(prop.value).toBeInstanceOf(Variant);
  expect(prop.value).toEqual(testIface.VariantProperty);

  await properties.Set(
    TEST_IFACE,
    'VariantProperty',
    new Variant('v', new Variant('d', 53))
  );
  prop = await properties.Get(TEST_IFACE, 'VariantProperty');
  expect(prop).toBeInstanceOf(Variant);
  expect(prop.value).toEqual(new Variant('d', 53));
  expect(prop.value).toEqual(testIface.VariantProperty);

  // test get all properties
  let all = await properties.GetAll(TEST_IFACE);
  expect(all).toHaveProperty(
    'SimpleProperty',
    new Variant('s', testIface.SimpleProperty)
  );
  expect(all).toHaveProperty(
    'VariantProperty',
    new Variant('v', testIface.VariantProperty)
  );
});

test('test complicated property get and set', async () => {
  let object = await bus.getProxyObject(TEST_NAME, TEST_PATH);
  let properties = object.getInterface('org.freedesktop.DBus.Properties');
  let prop = await properties.Get(TEST_IFACE, 'ComplicatedProperty');
  expect(prop).toBeInstanceOf(Variant);
  expect(prop.value).toEqual(testIface.ComplicatedProperty);

  let updatedProp = [
    {
      oof: new Variant('s', 'rab'),
      rab: new Variant('as', ['zif', 'zub', 'zork']),
      kevin: new Variant('a{sv}', {
        foo: new Variant('s', 'bar')
      })
    },
    'tab',
    new Variant('d', 23)
  ];

  await properties.Set(
    TEST_IFACE,
    'ComplicatedProperty',
    new Variant('(a{sv}sv)', updatedProp)
  );
  prop = await properties.Get(TEST_IFACE, 'ComplicatedProperty');
  expect(prop).toBeInstanceOf(Variant);
  expect(prop.value).toEqual(testIface.ComplicatedProperty);
  expect(prop.value).toEqual(updatedProp);
});

test('test properties changed signal', async () => {
  let object = await bus.getProxyObject(TEST_NAME, TEST_PATH);
  let properties = object.getInterface('org.freedesktop.DBus.Properties');
  let onPropertiesChanged = jest.fn((iface, changed, invalidated) => {
    // nop
  });
  properties.on('PropertiesChanged', onPropertiesChanged);

  await properties.Set(
    TEST_IFACE,
    'NotifyingProperty',
    new Variant('s', 'bar')
  );
  let e = {
    NotifyingProperty: new Variant('s', 'bar')
  };
  expect(onPropertiesChanged).toHaveBeenCalledWith(TEST_IFACE, e, ['invalid']);
});

test('test read and write access', async () => {
  let object = await bus.getProxyObject(TEST_NAME, TEST_PATH);
  let properties = object.getInterface('org.freedesktop.DBus.Properties');

  let req = properties.Get(TEST_IFACE, 'WriteOnly');
  await expect(req).rejects.toBeInstanceOf(MethodError);

  req = properties.Set(TEST_IFACE, 'ReadOnly', new Variant('s', 'foo'));
  await expect(req).rejects.toBeInstanceOf(MethodError);
});

test('test properties interface specific errors', async () => {
  let object = await bus.getProxyObject(TEST_NAME, TEST_PATH);
  let properties = object.getInterface('org.freedesktop.DBus.Properties');

  let req = properties.Set(
    'not.an.interface',
    'ReadOnly',
    new Variant('s', 'foo')
  );
  await expect(req).rejects.toBeInstanceOf(MethodError);

  req = properties.Get(TEST_IFACE, 'NotAProperty');
  await expect(req).rejects.toBeInstanceOf(MethodError);

  req = properties.Set(TEST_IFACE, 'NotAProperty', new Variant('s', 'foo'));
  await expect(req).rejects.toBeInstanceOf(MethodError);

  req = properties.Set(
    TEST_IFACE,
    'WriteOnly',
    new Variant('as', ['wrong', 'type'])
  );
  await expect(req).rejects.toBeInstanceOf(MethodError);
});
