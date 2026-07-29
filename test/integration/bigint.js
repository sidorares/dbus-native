// Opt-in BigInt over a real dbus-daemon.
//
// The unit tests marshall and unmarshall in one process; this proves the
// option survives the connection -- it is set on the client and has to reach
// the parser through the message layer, which is a different path.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const { sessionBus } = require('../utils/shape');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.BigInt';
const OBJECT_PATH = '/com/github/sidorares/dbusnative/BigInt';
const IFACE = 'com.github.sidorares.dbusnative.BigIntIface';

const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;
const UINT64_MAX = 18446744073709551615n;

const ifaceDesc = {
  name: IFACE,
  methods: {
    // echo a signed and an unsigned 64-bit value straight back
    EchoX: ['x', 'x', ['in'], ['out']],
    EchoT: ['t', 't', ['in'], ['out']],
    // A struct, not two return values: exportInterface sends whatever the
    // implementation returns as a single body element.
    BigOnes: ['', '(xt)', [], ['pair']]
  },
  signals: {},
  properties: {}
};

describe('integration: BigInt', { timeout: 10000, skip: NO_BUS }, () => {
  let serviceBus, bigClient, plainClient;

  const whenReady = bus =>
    new Promise((resolve, reject) =>
      bus.getId(err => (err ? reject(err) : resolve()))
    );

  const call = (bus, member, signature, body) =>
    bus.invoke({
      destination: SERVICE,
      path: OBJECT_PATH,
      interface: IFACE,
      member,
      ...(signature ? { signature, body } : {})
    });

  before(async () => {
    // The service reads its *arguments* through the same parser, so it needs
    // the option too. Without it an `x` argument arrives as a lossy number,
    // and echoing that back fails the 53-bit check on marshall -- loudly,
    // which is better than the silent truncation it would otherwise be.
    serviceBus = sessionBus({ returnBigInt: true });
    // The option is per connection, so the same daemon and the same service
    // can be read either way -- which is what makes migration incremental.
    bigClient = sessionBus({ returnBigInt: true });
    // Explicitly off rather than merely unset: this connection exists to show
    // the lossy path, and it has to keep showing it once `returnBigInt`
    // becomes the default.
    plainClient = sessionBus({ returnBigInt: false });

    const impl = Object.assign(Object.create(EventEmitter.prototype), {
      EchoX: v => v,
      EchoT: v => v,
      BigOnes: () => [INT64_MIN, UINT64_MAX]
    });
    EventEmitter.call(impl);

    await Promise.all([
      whenReady(serviceBus),
      whenReady(bigClient),
      whenReady(plainClient)
    ]);
    await new Promise((resolve, reject) =>
      serviceBus.requestName(SERVICE, 0, err => {
        if (err) return reject(err);
        serviceBus.exportInterface(impl, OBJECT_PATH, ifaceDesc);
        resolve();
      })
    );
  });

  after(() => {
    for (const bus of [serviceBus, bigClient, plainClient])
      if (bus) bus.connection.end();
  });

  it('carries the signed 64-bit maximum over the wire intact', async () => {
    assert.strictEqual(
      await call(bigClient, 'EchoX', 'x', [INT64_MAX]),
      INT64_MAX
    );
  });

  it('carries the signed 64-bit minimum over the wire intact', async () => {
    assert.strictEqual(
      await call(bigClient, 'EchoX', 'x', [INT64_MIN]),
      INT64_MIN
    );
  });

  it('carries the unsigned 64-bit maximum over the wire intact', async () => {
    assert.strictEqual(
      await call(bigClient, 'EchoT', 't', [UINT64_MAX]),
      UINT64_MAX
    );
  });

  it('reads several 64-bit values from one struct', async () => {
    const [signed, unsigned] = await call(bigClient, 'BigOnes');
    assert.strictEqual(signed, INT64_MIN);
    assert.strictEqual(unsigned, UINT64_MAX);
  });

  // Same daemon, same service, same message -- only the client option differs.
  it('leaves a client without the option on numbers', async () => {
    const value = await call(plainClient, 'EchoX', 'x', [INT64_MAX]);
    assert.strictEqual(typeof value, 'number');
    assert.notStrictEqual(BigInt(value), INT64_MAX, 'this is the lossy path');
  });

  it('accepts a bigint argument from a client that does not read them', async () => {
    // Writing is never gated on the read option.
    assert.strictEqual(await call(plainClient, 'EchoX', 'x', [42n]), 42);
  });
});
