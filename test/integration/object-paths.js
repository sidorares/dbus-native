// Walking a service's object tree, against a real bus.
//
// A container path -- one that groups child objects and implements nothing
// itself -- used to come back as its own first child, so calls went to an
// object the caller never named and the other children vanished.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const { sessionBus } = require('../utils/shape');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Paths';
const CONTAINER = '/com/github/sidorares/dbusnative/Paths';
const ALPHA = `${CONTAINER}/Alpha`;
const BETA = `${CONTAINER}/Beta`;

const descriptor = name => ({
  name,
  methods: { WhoAmI: ['', 's'] },
  signals: {},
  properties: {}
});

const impl = which => {
  const obj = Object.assign(Object.create(EventEmitter.prototype), {
    WhoAmI: () => which
  });
  EventEmitter.call(obj);
  return obj;
};

describe('integration: object paths', { timeout: 10000, skip: NO_BUS }, () => {
  let serviceBus, clientBus, service;

  before(async () => {
    serviceBus = sessionBus();
    clientBus = sessionBus();
    await Promise.all([serviceBus.getId(), clientBus.getId()]);
    await new Promise((resolve, reject) =>
      serviceBus.requestName(SERVICE, 0, err => (err ? reject(err) : resolve()))
    );
    // Nothing is exported at CONTAINER itself; it exists only as the parent.
    serviceBus.exportInterface(
      impl('alpha'),
      ALPHA,
      descriptor('com.example.Alpha')
    );
    serviceBus.exportInterface(
      impl('beta'),
      BETA,
      descriptor('com.example.Beta')
    );
    service = clientBus.getService(SERVICE);
  });

  after(() => {
    for (const bus of [serviceBus, clientBus]) if (bus) bus.connection.end();
  });

  const getObject = path =>
    new Promise((resolve, reject) =>
      service.getObject(path, (err, obj) => (err ? reject(err) : resolve(obj)))
    );

  it('returns the container itself, not its first child', async () => {
    const obj = await getObject(CONTAINER);
    assert.strictEqual(obj.name, CONTAINER, 'the path that was asked for');
    assert.deepStrictEqual(Object.keys(obj.proxy), []);
  });

  it('lists every child, including the first', async () => {
    const obj = await getObject(CONTAINER);
    assert.deepStrictEqual(obj.nodes.sort(), ['Alpha', 'Beta']);
  });

  it('says which children there are when asked for an interface', async () => {
    const obj = await getObject(CONTAINER);
    assert.throws(() => obj.as('com.example.Alpha'), {
      name: 'UnknownInterfaceError',
      message: /child objects: (Alpha, Beta|Beta, Alpha)/
    });
  });

  it('still talks to a child that was named properly', async () => {
    const obj = await getObject(ALPHA);
    assert.strictEqual(obj.name, ALPHA);
    const who = await new Promise((resolve, reject) =>
      obj
        .as('com.example.Alpha')
        .WhoAmI((err, value) => (err ? reject(err) : resolve(value)))
    );
    assert.strictEqual(who, 'alpha');
  });

  it('reports an unexported path as an object with nothing on it', async () => {
    // The server answers `<node/>` for a path it does not know, which is a
    // well-formed "nothing here" -- it used to be reported as a document with
    // no root node.
    const obj = await getObject(`${CONTAINER}/Nope`);
    assert.deepStrictEqual(Object.keys(obj.proxy), []);
    assert.deepStrictEqual(obj.nodes, []);
  });
});
