let dbus = require('../../');
let Variant = dbus.Variant;
let MethodError = dbus.MethodError;

let {
  Interface, property, method, signal,
  ACCESS_READ, ACCESS_WRITE, ACCESS_READWRITE
} = dbus.interface;

const TEST_NAME = 'org.test.name';
const TEST_PATH = '/org/test/path';
const TEST_IFACE = 'org.test.iface';

let bus = dbus.sessionBus();

afterAll(() => {
  bus.connection.stream.end();
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

/*
test('export two interfaces on different names', async () => {
  let [result1, result2, object ] = await Promise.all([
    bus.export(TEST_NAME1, TEST_PATH1, testIface1),
    bus.export(TEST_NAME2, TEST_PATH2, testIface2),
    bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')
  ]);
  expect(result1).toEqual(1);
  expect(result2).toEqual(1);
  let dbusIface = object.getInterface('org.freedesktop.DBus');
  let names = await dbusIface.ListNames();
  expect(names).toEqual(expect.arrayContaining([TEST_NAME1, TEST_NAME2]));
  // TODO test unexporting the names
});
*/

test('export a name already taken', async () => {
  let [result1, result2, object ] = await Promise.all([
    bus.export(TEST_NAME1, TEST_PATH1, testIface1),
    bus.export(TEST_NAME1, TEST_PATH1, testIface2),
    bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')
  ]);
  expect(result1).toEqual(1);
  expect(result2).toEqual(1);
});

// TODO call method on a name that has been unexported
