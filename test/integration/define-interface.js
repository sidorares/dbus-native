// A service declared with defineInterface(), answering on a real bus.
//
// The compilation is unit-tested without a daemon; what needs one is that the
// result actually serves -- methods, properties with accessors, the automatic
// PropertiesChanged, signals, and the introspection XML a client reads to build
// a proxy from it.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const dbus = require('../../index');
const { sessionBus } = require('../utils/shape');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Defined';
const PATH = '/com/github/sidorares/dbusnative/Defined';
const IFACE = 'com.github.sidorares.dbusnative.DefinedIface';

const settle = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));

describe(
  'integration: defineInterface',
  { timeout: 20000, skip: NO_BUS },
  () => {
    let serviceBus, clientBus, greeter, proxy, registration;
    let volume = 0.5;
    let callers = [];

    const whenReady = bus =>
      new Promise((resolve, reject) =>
        bus.getId(err => (err ? reject(err) : resolve()))
      );

    before(async () => {
      serviceBus = sessionBus();
      clientBus = sessionBus();
      await Promise.all([whenReady(serviceBus), whenReady(clientBus)]);
      await new Promise((resolve, reject) =>
        serviceBus.requestName(SERVICE, 0, err =>
          err ? reject(err) : resolve()
        )
      );

      greeter = dbus.defineInterface({
        name: IFACE,
        methods: {
          Hello: {
            in: { name: 's' },
            out: { greeting: 's' },
            handler: ({ name }, { sender }) => {
              callers.push(sender);
              return `Hello ${name}`;
            }
          },
          Split: {
            in: { text: 's' },
            out: { head: 's', tail: 's' },
            handler: ({ text }) => ({
              head: text.slice(0, 1),
              tail: text.slice(1)
            })
          },
          Fail: {
            handler: () => {
              const err = new Error('as declared');
              err.dbusName = 'com.example.Error.Declared';
              throw err;
            }
          }
        },
        properties: {
          Volume: {
            type: 'd',
            get: () => volume,
            set: v => {
              volume = v;
            }
          },
          Version: { type: 's', access: 'read', get: () => '1.2.3' },
          Secret: { type: 's', access: 'write', set: () => {} }
        },
        signals: { Greeted: { args: { who: 's' } } }
      });

      registration = await serviceBus.export(PATH, greeter);
      proxy = await clientBus.proxy(SERVICE, PATH, { interface: IFACE });
    });

    after(async () => {
      if (registration) await registration.remove();
      for (const bus of [serviceBus, clientBus]) if (bus) await bus.close();
    });

    describe('methods', () => {
      it('answers, with arguments arriving by name', async () => {
        assert.strictEqual(await proxy.Hello('world'), 'Hello world');
      });

      it('tells the handler who called, which closes #230', async () => {
        callers = [];
        await proxy.Hello('again');
        assert.strictEqual(callers.length, 1);
        assert.strictEqual(callers[0], clientBus.name);
        assert.match(callers[0], /^:\d+\.\d+$/);
      });

      it('returns several values, in declaration order', async () => {
        // The handler returns { head, tail }; the wire wants them positional.
        assert.deepStrictEqual(await proxy.Split('abc'), ['a', 'bc']);
      });

      it('propagates a thrown error with its name', async () => {
        await assert.rejects(() => proxy.Fail(), {
          dbusName: 'com.example.Error.Declared',
          message: 'as declared'
        });
      });
    });

    describe('properties', () => {
      it('reads through the getter', async () => {
        assert.strictEqual(await proxy.$props.Version, '1.2.3');
        assert.strictEqual(await proxy.$props.Volume, 0.5);
      });

      it('writes through the setter', async () => {
        await proxy.$props.$set('Volume', 0.75);
        assert.strictEqual(volume, 0.75, 'the setter ran');
        assert.strictEqual(await proxy.$props.Volume, 0.75);
      });

      it('enforces the declared access', async () => {
        await assert.rejects(() => proxy.$props.$set('Version', 'nope'), {
          dbusName: 'org.freedesktop.DBus.Error.PropertyReadOnly'
        });
        await assert.rejects(() => proxy.$props.Secret, {
          dbusName: 'org.freedesktop.DBus.Error.AccessDenied'
        });
      });

      it('omits the write-only one from GetAll', async () => {
        const all = await proxy.$props.$all();
        assert.deepStrictEqual(Object.keys(all).sort(), ['Version', 'Volume']);
      });

      it('emits PropertiesChanged on a write, without being asked', async () => {
        const changed = new Promise(resolve => {
          const key = clientBus.mangle(
            PATH,
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged'
          );
          clientBus.signals.once(key, body => resolve(body));
        });
        await clientBus.addMatch(
          `type='signal',path='${PATH}',interface='org.freedesktop.DBus.Properties'`
        );
        await proxy.$props.$set('Volume', 0.25);
        const [interfaceName, values] = await changed;
        assert.strictEqual(interfaceName, IFACE);
        assert.deepStrictEqual(require('../../lib/values').toPlain(values), {
          Volume: 0.25
        });
      });
    });

    describe('signals', () => {
      it('emits by name', async () => {
        const seen = [];
        const sub = await proxy.$watch('Greeted', who => seen.push(who));
        greeter.emit.Greeted('world');
        await settle();
        assert.deepStrictEqual(seen, ['world']);
        await sub.remove();
      });
    });

    describe('introspection', () => {
      it('advertises the arguments with the names they were given', async () => {
        const xml = await clientBus.invoke({
          destination: SERVICE,
          path: PATH,
          interface: 'org.freedesktop.DBus.Introspectable',
          member: 'Introspect'
        });
        assert.match(xml, new RegExp(`<interface name="${IFACE}">`));
        assert.match(
          xml,
          /<arg type="s" name="name" direction="in" ?\/>/,
          'the in argument keeps its name'
        );
        assert.match(
          xml,
          /<arg type="s" name="greeting" direction="out" ?\/>/,
          'and so does the out one'
        );
        assert.match(xml, /<property name="Version" type="s" access="read"\/>/);
        assert.match(xml, /<property name="Secret" type="s" access="write"\/>/);
        assert.match(xml, /<signal name="Greeted">/);
        assert.match(xml, /<arg type="s" name="who" ?\/>/);
      });
    });

    describe('the registration', () => {
      it('unexports, and the object stops answering', async () => {
        const iface = dbus.defineInterface({
          name: 'com.github.sidorares.dbusnative.Temporary',
          methods: { Knock: { out: { answer: 's' }, handler: () => 'pong' } }
        });
        const temp = `${PATH}/temp`;
        const reg = await serviceBus.export(temp, iface);

        const scoped = await clientBus.proxy(SERVICE, temp);
        assert.strictEqual(await scoped.Knock(), 'pong');

        await reg.remove();
        assert.strictEqual(reg.removed, true);
        await assert.rejects(() => scoped.Knock(), {
          dbusName: 'org.freedesktop.DBus.Error.UnknownMethod'
        });
      });

      it('releases through Symbol.asyncDispose', async () => {
        const iface = dbus.defineInterface({
          name: 'com.github.sidorares.dbusnative.Disposed',
          methods: { Knock: { handler: () => {} } }
        });
        const reg = await serviceBus.export(`${PATH}/disposed`, iface);
        await reg[Symbol.asyncDispose]();
        assert.strictEqual(reg.removed, true);
      });

      it('rejects something that is not a definition', async () => {
        await assert.rejects(
          () => serviceBus.export(`${PATH}/nope`, { name: 'x' }),
          /expects an interface from defineInterface/
        );
      });
    });
  }
);
