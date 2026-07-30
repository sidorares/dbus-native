// bus.objects(): the client-side live view of a service's object tree.
//
// Exercised against our own ObjectManager implementation, which is the only
// way to drive the interesting transitions on demand -- BlueZ will not add a
// device because a test asked it to.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const { sessionBus } = require('../utils/shape');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Tree';
const ROOT = '/com/github/sidorares/dbusnative/Tree';
const DEVICE = 'com.github.sidorares.dbusnative.TreeDevice';
const EXTRA = 'com.github.sidorares.dbusnative.TreeExtra';

const deviceIface = {
  name: DEVICE,
  methods: {},
  signals: {},
  properties: { Name: 's', Rssi: 'n', Secret: { type: 's', access: 'write' } }
};

const extraIface = {
  name: EXTRA,
  methods: {},
  signals: {},
  properties: { Tag: 's' }
};

const impl = fields => {
  const o = Object.assign(Object.create(EventEmitter.prototype), fields);
  EventEmitter.call(o);
  return o;
};

const settle = () => new Promise(resolve => setTimeout(resolve, 120));

describe('integration: bus.objects', { timeout: 15000, skip: NO_BUS }, () => {
  let serviceBus, clientBus, view;

  const whenReady = bus =>
    new Promise((resolve, reject) =>
      bus.getId(err => (err ? reject(err) : resolve()))
    );

  before(async () => {
    serviceBus = sessionBus();
    clientBus = sessionBus();
    await Promise.all([whenReady(serviceBus), whenReady(clientBus)]);
    await new Promise((resolve, reject) =>
      serviceBus.requestName(SERVICE, 0, err => (err ? reject(err) : resolve()))
    );
    serviceBus.exportObjectManager(ROOT);
  });

  after(async () => {
    if (view) await view.close();
    for (const bus of [serviceBus, clientBus]) if (bus) bus.connection.end();
  });

  // A fresh tree and a fresh view per test, so ordering between them cannot
  // matter -- these mutate the very thing they observe.
  beforeEach(async () => {
    if (view) await view.close();
    for (const path of Object.keys(serviceBus.exportedObjects)) {
      if (path.startsWith(`${ROOT}/`)) serviceBus.unexportInterface(path);
    }
    serviceBus.exportInterface(
      impl({ Name: 'hci0', Rssi: -40, Secret: 'shh' }),
      `${ROOT}/dev0`,
      deviceIface
    );
    view = await clientBus.objects(SERVICE, ROOT);
  });

  describe('the snapshot', () => {
    it('is the whole tree, in plain values', () => {
      assert.deepStrictEqual(view.objects, {
        [`${ROOT}/dev0`]: { [DEVICE]: { Name: 'hci0', Rssi: -40 } }
      });
    });

    it('answers paths(), get() and filter()', () => {
      assert.deepStrictEqual(view.paths(), [`${ROOT}/dev0`]);
      assert.deepStrictEqual(view.get(`${ROOT}/dev0`), {
        [DEVICE]: { Name: 'hci0', Rssi: -40 }
      });
      assert.strictEqual(view.get('/nope'), undefined);
      // filter() drops the interface name -- the caller just supplied it.
      assert.deepStrictEqual(view.filter(DEVICE), {
        [`${ROOT}/dev0`]: { Name: 'hci0', Rssi: -40 }
      });
      assert.deepStrictEqual(view.filter('com.example.Absent'), {});
    });

    it('resolves the well-known name to its owner', () => {
      assert.match(view.owner, /^:\d+\.\d+$/);
    });
  });

  describe('InterfacesAdded', () => {
    it('adds the object and emits', async () => {
      const seen = [];
      view.on('added', (path, interfaces) => seen.push([path, interfaces]));

      serviceBus.exportInterface(
        impl({ Name: 'hci1', Rssi: -70, Secret: 'x' }),
        `${ROOT}/dev1`,
        deviceIface
      );
      await settle();

      assert.deepStrictEqual(seen, [
        [`${ROOT}/dev1`, { [DEVICE]: { Name: 'hci1', Rssi: -70 } }]
      ]);
      assert.deepStrictEqual(view.filter(DEVICE), {
        [`${ROOT}/dev0`]: { Name: 'hci0', Rssi: -40 },
        [`${ROOT}/dev1`]: { Name: 'hci1', Rssi: -70 }
      });
    });

    it('merges a second interface onto an object it already has', async () => {
      serviceBus.exportInterface(
        impl({ Tag: 'blue' }),
        `${ROOT}/dev0`,
        extraIface
      );
      await settle();

      assert.deepStrictEqual(view.get(`${ROOT}/dev0`), {
        [DEVICE]: { Name: 'hci0', Rssi: -40 },
        [EXTRA]: { Tag: 'blue' }
      });
    });
  });

  describe('InterfacesRemoved', () => {
    it('drops the object and emits', async () => {
      const seen = [];
      view.on('removed', (path, names) => seen.push([path, names]));

      serviceBus.unexportInterface(`${ROOT}/dev0`);
      await settle();

      assert.deepStrictEqual(seen, [[`${ROOT}/dev0`, [DEVICE]]]);
      assert.deepStrictEqual(view.objects, {});
    });

    it('keeps the object while another interface remains', async () => {
      serviceBus.exportInterface(
        impl({ Tag: 'blue' }),
        `${ROOT}/dev0`,
        extraIface
      );
      await settle();
      serviceBus.unexportInterface(`${ROOT}/dev0`, EXTRA);
      await settle();

      assert.deepStrictEqual(view.get(`${ROOT}/dev0`), {
        [DEVICE]: { Name: 'hci0', Rssi: -40 }
      });
    });
  });

  describe('PropertiesChanged', () => {
    it('updates the value in place and emits', async () => {
      const seen = [];
      view.on('changed', (path, iface, changed) =>
        seen.push([path, iface, changed])
      );

      serviceBus.emitPropertiesChanged(`${ROOT}/dev0`, DEVICE, { Rssi: -55 });
      await settle();

      assert.deepStrictEqual(seen, [[`${ROOT}/dev0`, DEVICE, { Rssi: -55 }]]);
      assert.deepStrictEqual(view.get(`${ROOT}/dev0`)[DEVICE], {
        Name: 'hci0',
        Rssi: -55
      });
    });

    it('drops an invalidated property rather than keeping a stale value', async () => {
      serviceBus.emitPropertiesChanged(`${ROOT}/dev0`, DEVICE, {}, ['Rssi']);
      await settle();

      assert.deepStrictEqual(view.get(`${ROOT}/dev0`)[DEVICE], {
        Name: 'hci0'
      });
    });

    it('can be switched off, and then the value goes stale', async () => {
      await view.close();
      view = await clientBus.objects(SERVICE, ROOT, { properties: false });

      serviceBus.emitPropertiesChanged(`${ROOT}/dev0`, DEVICE, { Rssi: -99 });
      await settle();

      assert.strictEqual(view.get(`${ROOT}/dev0`)[DEVICE].Rssi, -40);
    });
  });

  describe('lifetime', () => {
    it('stops updating once closed', async () => {
      await view.close();
      serviceBus.exportInterface(
        impl({ Name: 'after', Rssi: 0, Secret: '' }),
        `${ROOT}/dev9`,
        deviceIface
      );
      await settle();
      assert.ok(!(`${ROOT}/dev9` in view.objects));
    });

    it('closes twice without complaint', async () => {
      await view.close();
      await view.close();
    });

    it('releases through Symbol.asyncDispose', async () => {
      const scoped = await clientBus.objects(SERVICE, ROOT);
      assert.strictEqual(typeof scoped[Symbol.asyncDispose], 'function');
      await scoped[Symbol.asyncDispose]();
      assert.strictEqual(scoped.closed, true);
    });

    it('says so when the service goes away, rather than going quietly stale', async () => {
      // A view whose service restarts under a new owner is not just out of
      // date, it is watching a name nobody answers on. Staying silent about
      // that is how a program stops working with no symptom to chase.
      const stale = new Promise(resolve => view.once('stale', resolve));
      await new Promise((resolve, reject) =>
        serviceBus.releaseName(SERVICE, err => (err ? reject(err) : resolve()))
      );
      assert.strictEqual(await stale, '', 'no new owner');

      // Put it back for the tests that follow.
      await new Promise((resolve, reject) =>
        serviceBus.requestName(SERVICE, 0, err =>
          err ? reject(err) : resolve()
        )
      );
    });
  });

  describe('the subscribe-then-fetch order', () => {
    // The bug this class exists to not have: fetch the snapshot first and
    // there is a window where an object appears, its InterfacesAdded goes
    // nowhere because nothing is subscribed yet, and the view is permanently
    // missing it.
    //
    // Timing that window from outside does not work -- an export issued right
    // after calling objects() lands while the *name lookup* is still in
    // flight, so it is in the snapshot and the test passes either way.
    // Verified: with the order deliberately reversed, that version stayed
    // green. So the service exports at the one moment that is provably inside
    // the window, on seeing the GetManagedObjects call itself.
    it('does not lose an object that appears while it is starting', async () => {
      await view.close();

      const exportOnFetch = msg => {
        if (msg.member !== 'GetManagedObjects') return;
        serviceBus.connection.removeListener('message', exportOnFetch);
        // The bus's own handler is registered first and has already written
        // the reply, so this is strictly after the snapshot was taken.
        serviceBus.exportInterface(
          impl({ Name: 'racy', Rssi: -1, Secret: '' }),
          `${ROOT}/racy`,
          deviceIface
        );
      };
      serviceBus.connection.on('message', exportOnFetch);

      view = await clientBus.objects(SERVICE, ROOT);
      await settle();

      serviceBus.connection.removeListener('message', exportOnFetch);
      assert.ok(
        `${ROOT}/racy` in view.objects,
        'an object added during startup must not be lost'
      );
    });
  });
});
