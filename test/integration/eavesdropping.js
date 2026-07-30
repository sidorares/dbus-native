// A connection must not answer messages it was merely allowed to see.
//
// This is the root cause of the integration flake that made the suite run
// `--test-concurrency=1`. A match rule with no `type=` -- `''`, or
// `eavesdrop='true'` -- makes the daemon deliver *every message on the bus* to
// that connection, including method calls addressed to somebody else. Dispatch
// never looked at `msg.destination`, so the eavesdropper treated each one as
// its own, found nothing exported, and replied
// `org.freedesktop.DBus.Error.UnknownMethod` -- to the original sender, with
// the original serial.
//
// The victim is whoever was waiting for the real reply. Their call fails with
// an error from a process they never talked to, in a different test file,
// depending on which reply arrived first. That is exactly the reported
// symptom: "a service answering UnknownMethod for something it had definitely
// exported", at random, only under concurrency.
//
// test/integration/match-rules.js installs both of those rules against the
// real daemon on purpose -- it checks which rules the daemon accepts -- so the
// suite was generating the traffic that broke itself.

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const { sessionBus } = require('../utils/shape');

const NO_BUS =
  !process.env.DBUS_SESSION_BUS_ADDRESS && 'no DBUS_SESSION_BUS_ADDRESS';

const SERVICE = 'com.github.sidorares.dbusnative.Overheard';
const PATH = '/com/github/sidorares/dbusnative/Overheard';
const IFACE = 'com.github.sidorares.dbusnative.OverheardIface';

describe('integration: eavesdropping', { timeout: 20000, skip: NO_BUS }, () => {
  let serviceBus, eavesdropper, caller;

  const whenReady = bus =>
    new Promise((resolve, reject) =>
      bus.getId(err => (err ? reject(err) : resolve()))
    );

  before(async () => {
    serviceBus = sessionBus();
    eavesdropper = sessionBus();
    caller = sessionBus();
    await Promise.all([
      whenReady(serviceBus),
      whenReady(eavesdropper),
      whenReady(caller)
    ]);

    await new Promise((resolve, reject) =>
      serviceBus.requestName(SERVICE, 0, err => (err ? reject(err) : resolve()))
    );
    const impl = Object.assign(Object.create(EventEmitter.prototype), {
      Echo: input => input
    });
    EventEmitter.call(impl);
    serviceBus.exportInterface(impl, PATH, {
      name: IFACE,
      methods: { Echo: ['s', 's', ['in'], ['out']] },
      signals: {},
      properties: {}
    });

    // The rule at the heart of it: no `type=`, so it matches method calls
    // too, and `eavesdrop` tells a modern daemon we mean it.
    await eavesdropper.addMatch("eavesdrop='true'");
  });

  after(async () => {
    for (const bus of [serviceBus, eavesdropper, caller]) {
      if (bus) await bus.close();
    }
  });

  it('does not answer a call addressed to someone else', async () => {
    // With the bug, the eavesdropper replies UnknownMethod using the
    // caller's own serial, and whichever reply lands first wins -- usually
    // the eavesdropper's, since it does no work.
    const answer = await caller.invoke({
      destination: SERVICE,
      path: PATH,
      interface: IFACE,
      member: 'Echo',
      signature: 's',
      body: ['still mine']
    });
    assert.strictEqual(answer, 'still mine');
  });

  it('does not answer a call it overhears to the bus itself', async () => {
    // The captured instance: a connection receiving back the AddMatch it had
    // just sent, and replying to itself.
    await caller.addMatch(
      `type='signal',interface='${IFACE}',member='Nothing'`
    );
    await caller.removeMatch(
      `type='signal',interface='${IFACE}',member='Nothing'`
    );
  });

  it('still answers calls that really are addressed to it', async () => {
    // The check has to be narrow enough not to make the service deaf.
    const answer = await caller.invoke({
      destination: SERVICE,
      path: PATH,
      interface: IFACE,
      member: 'Echo',
      signature: 's',
      body: ['addressed properly']
    });
    assert.strictEqual(answer, 'addressed properly');
  });

  it('answers when addressed by unique name too', async () => {
    const owner = await caller.getNameOwner(SERVICE);
    assert.match(owner, /^:\d+\.\d+$/);
    const answer = await caller.invoke({
      destination: owner,
      path: PATH,
      interface: IFACE,
      member: 'Echo',
      signature: 's',
      body: ['by unique name']
    });
    assert.strictEqual(answer, 'by unique name');
  });

  it('reports an unknown member on a call really meant for it', async () => {
    // Ignoring what is not ours must not turn into ignoring what is.
    await assert.rejects(
      () =>
        caller.invoke({
          destination: SERVICE,
          path: PATH,
          interface: IFACE,
          member: 'NoSuchMethod'
        }),
      { dbusName: 'org.freedesktop.DBus.Error.UnknownMethod' }
    );
  });
});
