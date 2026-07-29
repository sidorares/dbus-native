// Compile-time exercise of index.d.ts. Not executed -- `npm run test:types`
// type-checks it, so the definitions cannot drift from the API without CI
// noticing.
//
// Every construct here mirrors something documented in the README.

import dbus = require('../..');
import {
  MessageBus,
  DBusInterface,
  DBusError,
  TimeoutError,
  ConnectionClosedError,
  UnknownInterfaceError,
  Variant,
  variantValue,
  toPlain,
  Message
} from '../..';
import { toClassicError } from '../../lib/compat';

async function calls() {
  const bus: MessageBus = dbus.sessionBus({ timeout: 25000 });
  const system: MessageBus = dbus.systemBus();
  const client: MessageBus = dbus.createClient({ busAddress: 'unix:path=/x' });

  const msg: Message = {
    destination: 'org.freedesktop.DBus',
    path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus',
    member: 'GetId'
  };

  // promise form, with and without a type argument
  const id: string = await bus.invoke<string>(msg);
  const anything = await bus.invoke(msg);

  // options
  await bus.invoke(msg, { timeout: 5000 });
  await bus.invoke(msg, { signal: AbortSignal.timeout(5000) });

  // callback form, and options plus callback
  bus.invoke(msg, (err, value) => void (err ?? value));
  bus.invoke(msg, { timeout: 100 }, (err, value) => void (err ?? value));

  // meta methods, both forms
  const names: string[] = await bus.listNames();
  const hasOwner: boolean = await bus.nameHasOwner('org.freedesktop.DBus');
  const busId: string = await bus.getId();
  bus.getId((err, value: string) => void (err ?? value));
  await bus.requestName('com.example.Thing', 0);
  await bus.addMatch("type='signal'");
  await bus.removeMatch("type='signal'");

  void [id, anything, names, hasOwner, busId, system, client];
}

async function proxies() {
  const bus = dbus.sessionBus();

  const iface = await bus
    .getService('org.freedesktop.Notifications')
    .getInterface(
      '/org/freedesktop/Notifications',
      'org.freedesktop.Notifications'
    );

  const notificationId = await iface.Notify(
    'app',
    0,
    '',
    'summary',
    'body',
    [],
    {},
    5000
  );

  // a caller can describe the remote interface for a checked surface
  interface Player extends DBusInterface {
    PlayPause(): Promise<void>;
    Metadata(): Promise<unknown>;
  }
  const player = await bus
    .getService('org.mpris.MediaPlayer2.vlc')
    .getInterface<Player>(
      '/org/mpris/MediaPlayer2',
      'org.mpris.MediaPlayer2.Player'
    );
  await player.PlayPause();

  const obj = await bus.getObject(
    'org.freedesktop.DBus',
    '/org/freedesktop/DBus'
  );
  const asIface: DBusInterface = obj.as('org.freedesktop.DBus');

  await iface.$writeProp('Greeting', 'hi');
  const prop = await iface.$readProp('Greeting');

  void [notificationId, asIface, prop];
}

async function errors() {
  const bus = dbus.sessionBus();
  try {
    await bus.invoke({ member: 'Nope' });
  } catch (err) {
    if (err instanceof TimeoutError) {
      const ms: number = err.timeout;
      void ms;
    }
    if (err instanceof DBusError) {
      const name: string | undefined = err.dbusName;
      void name;
    }
    if (err instanceof ConnectionClosedError) {
      const code: 'ECONNCLOSED' = err.code;
      void code;
    }
    if (err instanceof UnknownInterfaceError) {
      const iface: string = err.interfaceName;
      void iface;
    }
  }

  // the callback form hands over a DBusError too
  bus.invoke({ member: 'Nope' }, (err, result) => {
    if (err) {
      const message: string = err.message;
      void [message, err.body, err.reply];
      // and the pre-0.7 array is reconstructable while migrating
      void toClassicError(err);
      return;
    }
    void result;
  });

  bus.connection.on('close', (cause?: Error) => void cause);
}

function values() {
  // reading works on either shape
  const greeting = variantValue<string>(['s', 'hello']);
  const props = toPlain<Record<string, unknown>>([['k', ['s', 'v']]]);

  // writing
  const v = new Variant('s', 'hello');
  const signature: string = v.signature;
  const value: string = v.value;

  void [greeting, props, signature, value];
}

function service() {
  const bus = dbus.sessionBus();
  const impl = {
    Echo(input: string) {
      return input;
    }
  };
  bus.exportInterface(impl, '/com/example/Thing', {
    name: 'com.example.Thing',
    methods: { Echo: ['s', 's', ['input'], ['output']] },
    signals: { Pinged: ['s', 'payload'] },
    properties: { Greeting: 's' }
  });

  bus.sendSignal('/com/example/Thing', 'com.example.Thing', 'Pinged', 's', [
    'hi'
  ]);

  const key: string = bus.mangle(
    '/com/example/Thing',
    'com.example.Thing',
    'Pinged'
  );
  bus.signals.on(key, (body: unknown[]) => void body);
}

function connections() {
  const conn = dbus.createConnection({ busAddress: 'unix:path=/x' });
  const writable: boolean = conn.message({ member: 'Hello', serial: 1 });
  conn.on('drain', () => {});
  conn.on('handlerError', (err: Error) => void err);
  conn.on('message', (m: Message) => void m.member);
  conn.end();
  void writable;
}

void [calls, proxies, errors, values, service, connections];
