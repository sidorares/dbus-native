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
let bus2 = dbus.sessionBus();

afterAll(() => {
  bus.connection.stream.end();
  bus2.connection.stream.end();
});

const TEST_NAME1 = 'org.test.name1';
const TEST_PATH1 = '/org/test/path1';
const TEST_IFACE1 = 'org.test.iface1';

const TEST_NAME2 = 'org.test.name2';
const TEST_PATH2 = '/org/test/path2';
const TEST_IFACE2 = 'org.test.iface2';

class ExampleInterfaceOne extends Interface {
  constructor() {
    super(TEST_IFACE1);
  }
}

class ExampleInterfaceTwo extends Interface {
  constructor() {
    super(TEST_IFACE2);
  }
}

let testIface1 = new ExampleInterfaceOne();
let testIface2 = new ExampleInterfaceTwo();

test('stub', async () => {
  await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
});

test('export and unexport interfaces and paths', async () => {
  let [result, dbusObject] = await Promise.all([
    bus.export(TEST_NAME1, TEST_PATH1, testIface1),
    bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')
  ]);

  expect(Object.keys(bus._names).length).toEqual(1);
  expect(Object.keys(bus._nameRequests).length).toEqual(1);

  // export the name and make sure it's on the bus
  let dbusIface = dbusObject.getInterface('org.freedesktop.DBus');
  let names = await dbusIface.ListNames();
  expect(names).toEqual(expect.arrayContaining([TEST_NAME1]));
  let obj = await bus.getProxyObject(TEST_NAME1, TEST_PATH1);
  let expectedIfaces = [
    testIface1.$name,
    'org.freedesktop.DBus.Properties',
    'org.freedesktop.DBus.Introspectable'
  ];
  for (let name of expectedIfaces) {
    expect(obj.interfaces.find(i => i.$name === name)).toBeDefined();
  }

  // unexport the name and make sure it leaves the bus
  await bus.unexportName(TEST_NAME1);
  expect(Object.keys(bus._names).length).toEqual(0);
  expect(Object.keys(bus._nameRequests).length).toEqual(0);
  names = await dbusIface.ListNames();
  expect(names).not.toEqual(expect.arrayContaining([TEST_NAME1]));

  // unexport a path and make sure it's gone
  result = await bus.export(TEST_NAME1, TEST_PATH1, testIface1);
  bus.unexportPath(TEST_NAME1, TEST_PATH1);
  obj = await bus.getProxyObject(TEST_NAME1, TEST_PATH1);
  expect(obj.interfaces.length).toEqual(0);

  // unexport an interface and make sure it's gone
  result = await bus.export(TEST_NAME1, TEST_PATH1, testIface1);
  await bus.unexportInterface(TEST_NAME1, TEST_PATH1, testIface1);
  obj = await bus.getProxyObject(TEST_NAME1, TEST_PATH1);
  expect(obj.interfaces.length).toEqual(0);

  await bus.unexportName(TEST_NAME1);
});

test('export two interfaces on different names', async () => {
  let [result1, result2, object] = await Promise.all([
    bus.export(TEST_NAME1, TEST_PATH1, testIface1),
    bus.export(TEST_NAME2, TEST_PATH2, testIface2),
    bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')
  ]);
  expect(Object.keys(bus._names).length).toEqual(2);
  let dbusIface = object.getInterface('org.freedesktop.DBus');
  let names = await dbusIface.ListNames();
  expect(names).toEqual(expect.arrayContaining([TEST_NAME1, TEST_NAME2]));

  await Promise.all([
    bus.unexportName(TEST_NAME1),
    bus.unexportName(TEST_NAME2)
  ]);
  expect(Object.keys(bus._names).length).toEqual(0);
});

test('export two interfaces on the same name on different paths', async () => {
  let [result1, result2, dbusObject] = await Promise.all([
    bus.export(TEST_NAME1, TEST_PATH1, testIface1),
    bus.export(TEST_NAME1, TEST_PATH2, testIface2),
    bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')
  ]);

  expect(Object.keys(bus._names).length).toEqual(1);
  let dbusIface = dbusObject.getInterface('org.freedesktop.DBus');

  let [names, obj1, obj2] = await Promise.all([
    dbusIface.ListNames(),
    bus.getProxyObject(TEST_NAME1, TEST_PATH1),
    bus.getProxyObject(TEST_NAME1, TEST_PATH2)
  ]);

  expect(names).toEqual(expect.arrayContaining([TEST_NAME1]));
  expect(obj1.getInterface(testIface1.$name)).toBeDefined();
  expect(obj2.getInterface(testIface2.$name)).toBeDefined();

  bus.unexportName(TEST_NAME1);
});

test('export a name taken by another bus and queue', async () => {
  await bus.export(TEST_NAME1, TEST_PATH1, testIface1);

  let [result1, dbusObject] = await Promise.all([
    bus2.export(TEST_NAME1, TEST_PATH1, testIface2),
    bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')
  ]);

  expect(Object.keys(bus._names).length).toEqual(1);
  expect(Object.keys(bus2._names).length).toEqual(1);

  let dbusIface = dbusObject.getInterface('org.freedesktop.DBus');
  let [names, obj] = await Promise.all([
    dbusIface.ListNames(),
    bus.getProxyObject(TEST_NAME1, TEST_PATH1)
  ]);

  expect(names).toEqual(expect.arrayContaining([TEST_NAME1]));
  expect(obj.getInterface(TEST_IFACE1)).toBeDefined();

  // bus2 should have the name in the queue so unexporting the name on bus1
  // should give it to bus2
  await bus.unexportName(TEST_NAME1);

  [names, obj] = await Promise.all([
    dbusIface.ListNames(),
    bus.getProxyObject(TEST_NAME1, TEST_PATH1)
  ]);
  expect(names).toEqual(expect.arrayContaining([TEST_NAME1]));
  expect(obj.getInterface(TEST_IFACE2)).toBeDefined();

  await bus2.unexportName(TEST_NAME1);
});
