// Test some of the standard dbus interfaces to make sure the client works
// correctly

let dbus = require('../../');
let bus = dbus.sessionBus();

afterAll(() => {
  bus.connection.stream.end();
});

test('lists names on the bus', async () => {
  let object = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
  let iface = object.getInterface('org.freedesktop.DBus');
  expect(iface).toBeDefined();
  let names = await iface.ListNames();
  expect(names.length).toBeGreaterThan(0);
  expect(names).toEqual(expect.arrayContaining(['org.freedesktop.DBus']));
});

test('get stats', async () => {
  let object = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
  let iface = object.getInterface('org.freedesktop.DBus.Debug.Stats');
  let stats = await iface.GetStats();
  expect(stats).toBeInstanceOf(Object);
  expect(stats).toHaveProperty('BusNames');
  let busNames = stats['BusNames'];
  expect(busNames).toBeInstanceOf(dbus.Variant);
  expect(busNames.signature).toBe('u');
  expect(busNames.value).toBeGreaterThan(0);
});
