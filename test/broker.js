// The in-process message bus.
//
// Everything here goes over a real socket through the real handshake and the
// real marshaller -- the only thing that is not a normal client is that the bus
// happens to live in this process.

const {
  describe,
  it,
  before,
  after,
  beforeEach,
  afterEach
} = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const dbus = require('../index');
const constants = require('../lib/constants');
const { REQUEST_NAME, RELEASE_NAME, NAME_FLAG } = require('../lib/broker');

const DBUS = {
  destination: 'org.freedesktop.DBus',
  path: '/org/freedesktop/DBus',
  interface: 'org.freedesktop.DBus'
};

describe('broker', { timeout: 20000 }, () => {
  let broker;
  let address;
  let opened;
  let faults;

  before(
    () =>
      new Promise((resolve, reject) => {
        broker = dbus.createBroker();
        faults = [];
        // A fault inside the bus shows up as a call that never answers, which
        // reads as a hung test rather than a broken one. Collect them so the
        // failure names itself.
        broker.on('error', err => faults.push(err));
        broker.on('clientError', err => faults.push(err));
        broker.listen((err, at) => {
          if (err) return reject(err);
          address = at;
          resolve();
        });
      })
  );

  after(() => new Promise(resolve => broker.close(resolve)));

  beforeEach(() => {
    opened = [];
    faults.length = 0;
  });

  afterEach(() => {
    for (const bus of opened) {
      try {
        bus.connection.stream.destroy();
      } catch {
        /* already gone */
      }
    }
    // Dropping a client mid-conversation is how several tests end, and the
    // read loop notices; only complain about faults from the bus itself.
    const real = faults.filter(
      err => !/ECONNRESET|EPIPE|closed/i.test(err.message)
    );
    assert.deepStrictEqual(
      real.map(err => err.message),
      [],
      'the bus reported no faults'
    );
  });

  /** A connected client, torn down after the test. */
  async function client(opts = {}) {
    const bus = dbus.createClient({ busAddress: address, ...opts });
    opened.push(bus);
    bus.connection.on('error', () => {});
    await bus.getId();
    return bus;
  }

  const request = (bus, name, flags = 0) =>
    bus.invokeDbus({
      member: 'RequestName',
      signature: 'su',
      body: [name, flags]
    });

  const release = (bus, name) =>
    bus.invokeDbus({ member: 'ReleaseName', signature: 's', body: [name] });

  /** Collect messages matching a predicate, after installing a match rule. */
  async function watch(bus, rule, predicate) {
    await bus.invokeDbus({ member: 'AddMatch', signature: 's', body: [rule] });
    const seen = [];
    bus.connection.on('message', msg => {
      if (!predicate || predicate(msg)) seen.push(msg);
    });
    return seen;
  }

  const settle = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));

  describe('Hello and unique names', () => {
    it('hands out :1.N names, one per connection', async () => {
      const a = await client();
      const b = await client();
      assert.match(a.name, /^:1\.\d+$/);
      assert.match(b.name, /^:1\.\d+$/);
      assert.notStrictEqual(a.name, b.name);
    });

    it('refuses a second Hello', async () => {
      const bus = await client();
      await assert.rejects(() => bus.invokeDbus({ member: 'Hello' }), {
        dbusName: 'org.freedesktop.DBus.Error.Failed'
      });
    });

    it('refuses anything else before Hello', async () => {
      // `direct` skips the automatic Hello, so this connection has no name.
      const bus = dbus.createClient({ busAddress: address, direct: true });
      opened.push(bus);
      bus.connection.on('error', () => {});
      await new Promise(resolve => bus.connection.once('connect', resolve));
      await assert.rejects(() => bus.invokeDbus({ member: 'ListNames' }), {
        dbusName: 'org.freedesktop.DBus.Error.AccessDenied'
      });
    });

    it('stamps the sender itself, ignoring what the client claims', async () => {
      const a = await client();
      const b = await client();
      const seen = await watch(
        b,
        "type='signal',interface='com.example.Spoof'"
      );
      a.connection.message({
        type: constants.messageType.signal,
        serial: 9999,
        path: '/com/example/Obj',
        interface: 'com.example.Spoof',
        member: 'Fired',
        sender: ':1.999'
      });
      await settle();
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0].sender, a.name, 'not the claimed :1.999');
    });
  });

  describe('RequestName', () => {
    it('makes the first caller the primary owner', async () => {
      const bus = await client();
      assert.strictEqual(
        await request(bus, 'com.example.First'),
        REQUEST_NAME.PRIMARY_OWNER
      );
    });

    it('tells an owner it already owns it', async () => {
      const bus = await client();
      await request(bus, 'com.example.Again');
      assert.strictEqual(
        await request(bus, 'com.example.Again'),
        REQUEST_NAME.ALREADY_OWNER
      );
    });

    it('queues a second claimant', async () => {
      const a = await client();
      const b = await client();
      await request(a, 'com.example.Queued');
      assert.strictEqual(
        await request(b, 'com.example.Queued'),
        REQUEST_NAME.IN_QUEUE
      );
    });

    it('reports EXISTS rather than queueing when asked not to queue', async () => {
      const a = await client();
      const b = await client();
      await request(a, 'com.example.NoQueue');
      assert.strictEqual(
        await request(b, 'com.example.NoQueue', NAME_FLAG.DO_NOT_QUEUE),
        REQUEST_NAME.EXISTS
      );
    });

    it('replaces an owner that allowed replacement', async () => {
      const a = await client();
      const b = await client();
      await request(a, 'com.example.Replace', NAME_FLAG.ALLOW_REPLACEMENT);
      assert.strictEqual(
        await request(b, 'com.example.Replace', NAME_FLAG.REPLACE_EXISTING),
        REQUEST_NAME.PRIMARY_OWNER
      );
      const owner = await b.invokeDbus({
        member: 'GetNameOwner',
        signature: 's',
        body: ['com.example.Replace']
      });
      assert.strictEqual(owner, b.name);
    });

    it('will not replace an owner that did not allow it', async () => {
      const a = await client();
      const b = await client();
      await request(a, 'com.example.Firm');
      assert.strictEqual(
        await request(b, 'com.example.Firm', NAME_FLAG.REPLACE_EXISTING),
        REQUEST_NAME.IN_QUEUE
      );
    });

    it('hands the name back when a replacing owner releases it', async () => {
      const a = await client();
      const b = await client();
      await request(a, 'com.example.Hand', NAME_FLAG.ALLOW_REPLACEMENT);
      await request(b, 'com.example.Hand', NAME_FLAG.REPLACE_EXISTING);
      assert.strictEqual(
        await release(b, 'com.example.Hand'),
        RELEASE_NAME.RELEASED
      );
      const owner = await a.invokeDbus({
        member: 'GetNameOwner',
        signature: 's',
        body: ['com.example.Hand']
      });
      assert.strictEqual(owner, a.name, 'back to the one that was replaced');
    });

    it('refuses a malformed name, a unique name and the bus name', async () => {
      const bus = await client();
      for (const name of ['no-dot', ':1.5', 'org.freedesktop.DBus', '']) {
        await assert.rejects(
          () => request(bus, name),
          { dbusName: 'org.freedesktop.DBus.Error.InvalidArgs' },
          name
        );
      }
    });
  });

  describe('ReleaseName', () => {
    it('releases a name it owns', async () => {
      const bus = await client();
      await request(bus, 'com.example.Drop');
      assert.strictEqual(
        await release(bus, 'com.example.Drop'),
        RELEASE_NAME.RELEASED
      );
      assert.strictEqual(
        await bus.invokeDbus({
          member: 'NameHasOwner',
          signature: 's',
          body: ['com.example.Drop']
        }),
        false
      );
    });

    it('reports a name nobody owns', async () => {
      const bus = await client();
      assert.strictEqual(
        await release(bus, 'com.example.Nobody'),
        RELEASE_NAME.NON_EXISTENT
      );
    });

    it('reports a name owned by someone else', async () => {
      const a = await client();
      const b = await client();
      await request(a, 'com.example.Theirs');
      assert.strictEqual(
        await release(b, 'com.example.Theirs'),
        RELEASE_NAME.NOT_OWNER
      );
    });

    it('promotes the next in the queue', async () => {
      const a = await client();
      const b = await client();
      await request(a, 'com.example.Succeed');
      await request(b, 'com.example.Succeed');
      await release(a, 'com.example.Succeed');
      const owner = await b.invokeDbus({
        member: 'GetNameOwner',
        signature: 's',
        body: ['com.example.Succeed']
      });
      assert.strictEqual(owner, b.name);
    });
  });

  describe('the bus object', () => {
    it('lists names, and says who owns them', async () => {
      const bus = await client();
      await request(bus, 'com.example.Listed');
      const names = await bus.invokeDbus({ member: 'ListNames' });
      assert.ok(names.includes('org.freedesktop.DBus'));
      assert.ok(names.includes(bus.name));
      assert.ok(names.includes('com.example.Listed'));
    });

    it('answers NameHasOwner for the bus itself', async () => {
      const bus = await client();
      assert.strictEqual(
        await bus.invokeDbus({
          member: 'NameHasOwner',
          signature: 's',
          body: ['org.freedesktop.DBus']
        }),
        true
      );
    });

    it('reports NameHasNoOwner for an unowned name', async () => {
      const bus = await client();
      await assert.rejects(
        () =>
          bus.invokeDbus({
            member: 'GetNameOwner',
            signature: 's',
            body: ['com.example.Absent']
          }),
        { dbusName: 'org.freedesktop.DBus.Error.NameHasNoOwner' }
      );
    });

    it('lists queued owners in order', async () => {
      const a = await client();
      const b = await client();
      const c = await client();
      await request(a, 'com.example.Order');
      await request(b, 'com.example.Order');
      await request(c, 'com.example.Order');
      const queued = await a.invokeDbus({
        member: 'ListQueuedOwners',
        signature: 's',
        body: ['com.example.Order']
      });
      assert.deepStrictEqual(queued, [a.name, b.name, c.name]);
    });

    it('answers GetConnectionCredentials, as the daemon does', async () => {
      // The modern replacement for GetConnectionUnix{User,ProcessID}, and what
      // most code asks for now. Added because a CLI test that used it passed
      // against dbus-daemon and failed here -- which is the whole point of
      // running the integration suite against both.
      const a = await client();
      const b = await client();
      await request(a, 'com.example.Credentials');
      const credentials = dbus.toPlain(
        await b.invokeDbus({
          member: 'GetConnectionCredentials',
          signature: 's',
          body: ['com.example.Credentials']
        })
      );
      assert.strictEqual(typeof credentials.ProcessID, 'number');
      assert.ok(credentials.ProcessID > 0);
      if (typeof process.getuid === 'function') {
        assert.strictEqual(credentials.UnixUserID, process.getuid());
      }
    });

    it('reports NameHasNoOwner from GetConnectionCredentials', async () => {
      const bus = await client();
      await assert.rejects(
        () =>
          bus.invokeDbus({
            member: 'GetConnectionCredentials',
            signature: 's',
            body: ['com.example.Absent']
          }),
        { dbusName: 'org.freedesktop.DBus.Error.NameHasNoOwner' }
      );
    });

    it('answers GetId with a stable bus id', async () => {
      const a = await client();
      const b = await client();
      const first = await a.invokeDbus({ member: 'GetId' });
      assert.match(first, /^[0-9a-f]{32}$/);
      assert.strictEqual(await b.invokeDbus({ member: 'GetId' }), first);
    });

    it('answers Peer.Ping and Peer.GetMachineId', async () => {
      const bus = await client();
      await bus.invoke({
        ...DBUS,
        interface: 'org.freedesktop.DBus.Peer',
        member: 'Ping'
      });
      const id = await bus.invoke({
        ...DBUS,
        interface: 'org.freedesktop.DBus.Peer',
        member: 'GetMachineId'
      });
      assert.match(id, /^[0-9a-f]{32}$/);
    });

    it('is introspectable, and the XML parses', async () => {
      const bus = await client();
      const xml = await bus.invoke({
        ...DBUS,
        interface: 'org.freedesktop.DBus.Introspectable',
        member: 'Introspect'
      });
      const { parseStringPromise } = require('xml2js');
      const doc = await parseStringPromise(xml);
      const ifaces = doc.node.interface.map(i => i.$.name);
      assert.ok(ifaces.includes('org.freedesktop.DBus'));
      assert.ok(ifaces.includes('org.freedesktop.DBus.Peer'));
    });

    it('answers Properties.GetAll on itself', async () => {
      const bus = await client();
      const all = await bus.invoke({
        ...DBUS,
        interface: 'org.freedesktop.DBus.Properties',
        member: 'GetAll',
        signature: 's',
        body: ['org.freedesktop.DBus']
      });
      assert.deepStrictEqual(
        dbus.toPlain(all),
        { Features: [], Interfaces: [] },
        'the properties the daemon exposes'
      );
    });

    it('has no activatable services, and says so', async () => {
      const bus = await client();
      await assert.rejects(
        () =>
          bus.invokeDbus({
            member: 'StartServiceByName',
            signature: 'su',
            body: ['com.example.NotActivatable', 0]
          }),
        err => {
          assert.strictEqual(
            err.dbusName,
            'org.freedesktop.DBus.Error.ServiceUnknown'
          );
          assert.match(err.message, /does not activate services/);
          return true;
        }
      );
    });

    it('refuses an unknown method and an unknown object', async () => {
      const bus = await client();
      await assert.rejects(() => bus.invokeDbus({ member: 'Nonsense' }), {
        dbusName: 'org.freedesktop.DBus.Error.UnknownMethod'
      });
      await assert.rejects(
        () =>
          bus.invoke({
            ...DBUS,
            path: '/org/freedesktop/Elsewhere',
            member: 'ListNames'
          }),
        { dbusName: 'org.freedesktop.DBus.Error.UnknownObject' }
      );
    });
  });

  describe('match rules', () => {
    it('accepts and removes a rule', async () => {
      const bus = await client();
      const rule = "type='signal',member='Pinged'";
      await bus.invokeDbus({
        member: 'AddMatch',
        signature: 's',
        body: [rule]
      });
      await bus.invokeDbus({
        member: 'RemoveMatch',
        signature: 's',
        body: [rule]
      });
    });

    it('refuses an invalid rule with MatchRuleInvalid', async () => {
      const bus = await client();
      await assert.rejects(
        () =>
          bus.invokeDbus({
            member: 'AddMatch',
            signature: 's',
            body: ["nonsense='x'"]
          }),
        err => {
          assert.strictEqual(
            err.dbusName,
            'org.freedesktop.DBus.Error.MatchRuleInvalid'
          );
          assert.match(err.message, /unknown key "nonsense"/);
          return true;
        }
      );
    });

    it('reports removing a rule that was never added', async () => {
      const bus = await client();
      await assert.rejects(
        () =>
          bus.invokeDbus({
            member: 'RemoveMatch',
            signature: 's',
            body: ["type='signal'"]
          }),
        { dbusName: 'org.freedesktop.DBus.Error.MatchRuleNotFound' }
      );
    });
  });

  describe('routing', () => {
    it('carries a method call between two clients', async () => {
      const service = await client();
      const caller = await client();
      await request(service, 'com.example.Routed');

      const impl = Object.assign(Object.create(EventEmitter.prototype), {
        Echo: text => `echoed: ${text}`
      });
      EventEmitter.call(impl);
      service.exportInterface(impl, '/com/example/Routed', {
        name: 'com.example.RoutedIface',
        methods: { Echo: ['s', 's', ['text'], ['out']] },
        signals: {},
        properties: {}
      });

      const result = await caller.invoke({
        destination: 'com.example.Routed',
        path: '/com/example/Routed',
        interface: 'com.example.RoutedIface',
        member: 'Echo',
        signature: 's',
        body: ['hello']
      });
      assert.strictEqual(result, 'echoed: hello');
    });

    it('works through the proxy API, introspection and all', async () => {
      const service = await client();
      const caller = await client();
      await request(service, 'com.example.Proxied');
      const impl = Object.assign(Object.create(EventEmitter.prototype), {
        Add: (a, b) => a + b,
        Greeting: 'hi'
      });
      EventEmitter.call(impl);
      service.exportInterface(impl, '/com/example/Proxied', {
        name: 'com.example.ProxiedIface',
        methods: { Add: ['uu', 'u', ['a', 'b'], ['sum']] },
        signals: {},
        properties: { Greeting: 's' }
      });

      const iface = await new Promise((resolve, reject) =>
        caller.getInterface(
          'com.example.Proxied',
          '/com/example/Proxied',
          'com.example.ProxiedIface',
          (err, value) => (err ? reject(err) : resolve(value))
        )
      );
      const sum = await new Promise((resolve, reject) =>
        iface.Add(2, 3, (err, value) => (err ? reject(err) : resolve(value)))
      );
      assert.strictEqual(sum, 5);
    });

    it('reports a destination nobody owns', async () => {
      const bus = await client();
      await assert.rejects(
        () =>
          bus.invoke({
            destination: 'com.example.Missing',
            path: '/',
            interface: 'com.example.I',
            member: 'M'
          }),
        { dbusName: 'org.freedesktop.DBus.Error.NameHasNoOwner' }
      );
    });

    it('refuses a method call with no destination', async () => {
      const bus = await client();
      await assert.rejects(
        () =>
          bus.invoke({
            path: '/com/example/Obj',
            interface: 'com.example.I',
            member: 'M'
          }),
        { dbusName: 'org.freedesktop.DBus.Error.Failed' }
      );
    });

    it('routes to a unique name as well as a well-known one', async () => {
      const service = await client();
      const caller = await client();
      const impl = Object.assign(Object.create(EventEmitter.prototype), {
        Who: () => 'unique'
      });
      EventEmitter.call(impl);
      service.exportInterface(impl, '/com/example/Uniq', {
        name: 'com.example.UniqIface',
        methods: { Who: ['', 's', [], ['out']] },
        signals: {},
        properties: {}
      });
      const who = await caller.invoke({
        destination: service.name,
        path: '/com/example/Uniq',
        interface: 'com.example.UniqIface',
        member: 'Who'
      });
      assert.strictEqual(who, 'unique');
    });
  });

  describe('signals', () => {
    it('delivers a broadcast to a client whose rule matches', async () => {
      const sender = await client();
      const listener = await client();
      const seen = await watch(
        listener,
        "type='signal',interface='com.example.Broadcast'",
        msg => msg['interface'] === 'com.example.Broadcast'
      );
      sender.sendSignal(
        '/com/example/Obj',
        'com.example.Broadcast',
        'Fired',
        's',
        ['payload']
      );
      await settle();
      assert.strictEqual(seen.length, 1);
      assert.deepStrictEqual(seen[0].body, ['payload']);
      assert.strictEqual(seen[0].sender, sender.name);
    });

    it('does not deliver one nobody asked for', async () => {
      const sender = await client();
      const listener = await client();
      const seen = [];
      listener.connection.on('message', msg => {
        if (msg['interface'] === 'com.example.Unwanted') seen.push(msg);
      });
      sender.sendSignal(
        '/com/example/Obj',
        'com.example.Unwanted',
        'Fired',
        's',
        ['x']
      );
      await settle();
      assert.deepStrictEqual(seen, []);
    });

    it('delivers a signal back to its own sender when a rule matches', async () => {
      // Which is what dbus-daemon does; checked against it before implementing.
      const bus = await client();
      const seen = await watch(
        bus,
        "type='signal',interface='com.example.Echo'",
        msg => msg['interface'] === 'com.example.Echo'
      );
      bus.sendSignal('/com/example/Obj', 'com.example.Echo', 'Fired', 's', [
        'x'
      ]);
      await settle();
      assert.strictEqual(seen.length, 1);
    });

    it('honours argN filtering', async () => {
      const sender = await client();
      const listener = await client();
      const seen = await watch(
        listener,
        "type='signal',interface='com.example.Filtered',arg0='wanted'",
        msg => msg['interface'] === 'com.example.Filtered'
      );
      for (const value of ['unwanted', 'wanted']) {
        sender.sendSignal(
          '/com/example/Obj',
          'com.example.Filtered',
          'Fired',
          's',
          [value]
        );
      }
      await settle();
      assert.strictEqual(seen.length, 1);
      assert.deepStrictEqual(seen[0].body, ['wanted']);
    });

    it('drops a unicast signal to a name nobody owns', async () => {
      const bus = await client();
      // No reply is expected for a signal, so the check is that the bus
      // survives and keeps answering.
      bus.connection.message({
        type: constants.messageType.signal,
        serial: 4242,
        destination: 'com.example.Gone',
        path: '/com/example/Obj',
        interface: 'com.example.I',
        member: 'Fired'
      });
      await settle(60);
      assert.ok(Array.isArray(await bus.invokeDbus({ member: 'ListNames' })));
    });
  });

  describe('NameOwnerChanged', () => {
    const RULE =
      "type='signal',sender='org.freedesktop.DBus'," +
      "interface='org.freedesktop.DBus',member='NameOwnerChanged'";

    it('announces a name being taken and given up', async () => {
      const watcher = await client();
      const owner = await client();
      const seen = await watch(
        watcher,
        RULE,
        m => m.member === 'NameOwnerChanged'
      );

      await request(owner, 'com.example.Announced');
      await release(owner, 'com.example.Announced');
      await settle();

      const ours = seen.filter(m => m.body[0] === 'com.example.Announced');
      assert.deepStrictEqual(
        ours.map(m => m.body),
        [
          ['com.example.Announced', '', owner.name],
          ['com.example.Announced', owner.name, '']
        ]
      );
    });

    it('announces a connection arriving and leaving', async () => {
      const watcher = await client();
      const seen = await watch(
        watcher,
        RULE,
        m => m.member === 'NameOwnerChanged'
      );

      const transient = await client();
      const name = transient.name;
      await settle();
      transient.connection.stream.destroy();
      await settle();

      const arrived = seen.find(m => m.body[0] === name && m.body[2] === name);
      const left = seen.find(m => m.body[0] === name && m.body[2] === '');
      assert.ok(arrived, `no arrival for ${name}`);
      assert.ok(left, `no departure for ${name}`);
    });

    it('hands a dead owner name to the next in the queue', async () => {
      const watcher = await client();
      const first = await client();
      const second = await client();
      const seen = await watch(
        watcher,
        RULE,
        m => m.member === 'NameOwnerChanged'
      );

      await request(first, 'com.example.Inherited');
      await request(second, 'com.example.Inherited');
      first.connection.stream.destroy();
      await settle(250);

      const owner = await watcher.invokeDbus({
        member: 'GetNameOwner',
        signature: 's',
        body: ['com.example.Inherited']
      });
      assert.strictEqual(owner, second.name);
      assert.ok(
        seen.some(
          m =>
            m.body[0] === 'com.example.Inherited' && m.body[2] === second.name
        ),
        'and it was announced'
      );
    });
  });

  describe('NameAcquired and NameLost', () => {
    it('tells a connection its own unique name', async () => {
      // Sent without any match rule, which is what libdbus relies on.
      const bus = dbus.createClient({ busAddress: address });
      opened.push(bus);
      bus.connection.on('error', () => {});
      const acquired = [];
      bus.connection.on('message', msg => {
        if (msg.member === 'NameAcquired') acquired.push(msg.body[0]);
      });
      await bus.getId();
      await settle();
      assert.ok(acquired.includes(bus.name), `got ${JSON.stringify(acquired)}`);
    });

    it('tells the loser and the winner when a name changes hands', async () => {
      const a = await client();
      const b = await client();
      const lost = [];
      const won = [];
      a.connection.on('message', msg => {
        if (msg.member === 'NameLost') lost.push(msg.body[0]);
      });
      b.connection.on('message', msg => {
        if (msg.member === 'NameAcquired') won.push(msg.body[0]);
      });

      await request(a, 'com.example.Handover', NAME_FLAG.ALLOW_REPLACEMENT);
      await request(b, 'com.example.Handover', NAME_FLAG.REPLACE_EXISTING);
      await settle();

      assert.ok(lost.includes('com.example.Handover'));
      assert.ok(won.includes('com.example.Handover'));
    });
  });

  // Forwarding here means unmarshalling a message and marshalling it again, so
  // anything the reader and the writer disagree about becomes a routing bug.
  // The first version of this lost 64-bit values: they were read as Numbers and
  // then refused on the way out with "Number outside range".
  describe('what survives being routed', () => {
    const INT64_MAX = 9223372036854775807n;
    const INT64_MIN = -9223372036854775808n;
    const UINT64_MAX = 18446744073709551615n;

    let service, caller;

    before(async () => {
      service = dbus.createClient({ busAddress: address, returnBigInt: true });
      caller = dbus.createClient({ busAddress: address, returnBigInt: true });
      service.connection.on('error', () => {});
      caller.connection.on('error', () => {});
      await Promise.all([service.getId(), caller.getId()]);
      await service.invokeDbus({
        member: 'RequestName',
        signature: 'su',
        body: ['com.example.Fidelity', 0]
      });

      const impl = Object.assign(Object.create(EventEmitter.prototype), {
        EchoX: value => value,
        EchoT: value => value,
        EchoDict: value => value,
        EchoBytes: value => value,
        EchoVariant: value => value,
        EchoNested: value => value
      });
      EventEmitter.call(impl);
      service.exportInterface(impl, '/com/example/Fidelity', {
        name: 'com.example.FidelityIface',
        methods: {
          EchoX: ['x', 'x', ['in'], ['out']],
          EchoT: ['t', 't', ['in'], ['out']],
          EchoDict: ['a{ss}', 'a{ss}', ['in'], ['out']],
          EchoBytes: ['ay', 'ay', ['in'], ['out']],
          EchoVariant: ['v', 'v', ['in'], ['out']],
          EchoNested: ['a(sit)', 'a(sit)', ['in'], ['out']]
        },
        signals: {},
        properties: {}
      });
    });

    after(() => {
      for (const bus of [service, caller]) {
        try {
          bus.connection.stream.destroy();
        } catch {
          /* already gone */
        }
      }
    });

    const echo = (member, signature, value) =>
      caller.invoke({
        destination: 'com.example.Fidelity',
        path: '/com/example/Fidelity',
        interface: 'com.example.FidelityIface',
        member,
        signature,
        body: [value]
      });

    for (const value of [INT64_MAX, INT64_MIN, -1n, 0n, 1n]) {
      it(`routes the signed 64-bit value ${value} intact`, async () => {
        assert.strictEqual(await echo('EchoX', 'x', value), value);
      });
    }

    for (const value of [UINT64_MAX, 0n, 1n]) {
      it(`routes the unsigned 64-bit value ${value} intact`, async () => {
        assert.strictEqual(await echo('EchoT', 't', value), value);
      });
    }

    it('routes a dict intact', async () => {
      const sent = [
        ['alpha', 'one'],
        ['beta', 'two']
      ];
      assert.deepStrictEqual(await echo('EchoDict', 'a{ss}', sent), sent);
    });

    it('routes a byte array intact', async () => {
      const sent = Buffer.from([0, 1, 127, 128, 255]);
      const back = await echo('EchoBytes', 'ay', sent);
      assert.deepStrictEqual(Buffer.from(back), sent);
    });

    it('routes a variant intact', async () => {
      const back = await echo('EchoVariant', 'v', ['s', 'inside a variant']);
      assert.strictEqual(dbus.variantValue(back), 'inside a variant');
      assert.strictEqual(dbus.variantSignature(back), 's');
    });

    it('routes a nested struct with a 64-bit field intact', async () => {
      const sent = [
        ['first', -7, UINT64_MAX],
        ['second', 0, 0n]
      ];
      assert.deepStrictEqual(await echo('EchoNested', 'a(sit)', sent), sent);
    });
  });

  describe('surviving misbehaviour', () => {
    it('keeps serving other clients when one disappears mid-conversation', async () => {
      const doomed = await client();
      const survivor = await client();
      await request(doomed, 'com.example.Doomed');
      doomed.connection.stream.destroy();
      await settle();
      assert.ok(
        Array.isArray(await survivor.invokeDbus({ member: 'ListNames' }))
      );
      assert.strictEqual(
        await survivor.invokeDbus({
          member: 'NameHasOwner',
          signature: 's',
          body: ['com.example.Doomed']
        }),
        false,
        'and the dead name is gone'
      );
    });

    it('answers a call to an unknown interface on the bus object', async () => {
      const bus = await client();
      await assert.rejects(
        () =>
          bus.invoke({
            ...DBUS,
            interface: 'com.example.NotABusInterface',
            member: 'Whatever'
          }),
        { dbusName: 'org.freedesktop.DBus.Error.UnknownInterface' }
      );
    });
  });
});
