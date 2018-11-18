node-dbus
===========

[![Greenkeeper badge](https://badges.greenkeeper.io/sidorares/dbus-native.svg)](https://greenkeeper.io/)
D-bus protocol client and server for node.js

[![Build Status](https://secure.travis-ci.org/sidorares/dbus-native.png)](http://travis-ci.org/sidorares/dbus-native)

Installation
------------

```shell
npm install dbus-native
```
or

```shell
git clone https://github.com/sidorares/node-dbus # clone the repo
cd node-dbus
npm install # install dependencies
sudo cp examples/com.github.sidorares.dbus.Example.conf /etc/dbus-1/system.d/ # if you want to test examples/service.js
```

Usage
------

Short example using desktop notifications service

```js
var dbus = require('dbus-native');
var sessionBus = dbus.sessionBus();
sessionBus.getService('org.freedesktop.Notifications').getInterface(
    '/org/freedesktop/Notifications',
    'org.freedesktop.Notifications', function(err, notifications) {

    // dbus signals are EventEmitter events
    notifications.on('ActionInvoked', function() {
        console.log('ActionInvoked', arguments);
    });
    notifications.on('NotificationClosed', function() {
        console.log('NotificationClosed', arguments);
    });
    notifications.Notify('exampl', 0, '', 'summary 3', 'new message text', ['xxx yyy', 'test2', 'test3', 'test4'], [],  5, function(err, id) {
       //setTimeout(function() { n.CloseNotification(id, console.log); }, 4000);
    });
});
```

API
---

### Low level messaging: bus connection

`connection = dbus.createClient(options)`

options:
   - socket - unix socket path
   - port - TCP port
   - host - TCP host
   - busAddress - encoded bus address. Default is `DBUS_SESSION_BUS_ADDRESS` environment variable. See http://dbus.freedesktop.org/doc/dbus-specification.html#addresses
   - authMethods - array of authentication methods, which are attempted in the order provided (default:['EXTERNAL', 'DBUS_COOKIE_SHA1', 'ANONYMOUS'])
   - ayBuffer - boolean (default:true): if true 'ay' dbus fields are returned as buffers
   - ReturnLongjs - boolean (default:false): if true 64 bit dbus fields (x/t) are read out as Long.js objects, otherwise they are converted to numbers (which should be good up to 53 bits)
   - ( TODO: add/document option to use adress from X11 session )

connection has only one method, `message(msg)`

message fields:
   - type - methodCall, methodReturn, error or signal
   - path - object path
   - interface
   - destination
   - sender
   - member
   - serial
   - signature
   - body
   - errorName
   - replySerial

connection signals:
   - connect - emitted after successful authentication
   - message
   - error

example:

```js
var dbus = require('dbus-native');
var conn = dbus.createConnection();
conn.message({
    path:'/org/freedesktop/DBus',
    destination: 'org.freedesktop.DBus',
    'interface': 'org.freedesktop.DBus',
    member: 'Hello',
    type: dbus.messageType.methodCall
});
conn.on('message', function(msg) { console.log(msg); });
```

### Note on INT64 'x' and UINT64 't'
Long.js is used for 64 Bit support. https://github.com/dcodeIO/long.js
The following javascript types can be marshalled into 64 bit dbus fields:
   - typeof 'number' up to 53bits
   - typeof 'string' (consisting of decimal digits with no separators or '0x' prefixed hexadecimal) up to full 64bit range
   - Long.js objects (or object with compatible properties)

By default 64 bit dbus fields are unmarshalled into a 'number' (with precision loss beyond 53 bits). Use {ReturnLongjs:true} option to return the actual Long.js object and preserve the entire 64 bits.

## The New High Level API

The new high level api includes better support for dbus types and variants and uses modern JavaScript language features.

*The high level API should be considered experimental and is under active development.*

## The New Client Interface

You can get a proxy object for a name on the bus with the `bus.getProxyObject()` function, passing the name and the path. The proxy object contains introspection data about the object including a list of nodes and interfaces. You can get an interface with the `object.getInterface()` function passing the name of the interface.

The interface object has methods you can call that correspond to the methods in the introspection data. Pass normal JavaScript objects to the parameters of the function and they will automatically be converted into the advertized DBus type. However, you must use the `Variant` class to represent DBus variants.

Methods will similarly return JavaScript objects converted from the advertised DBus type, with the `Variant` class used to represent returned variants. If the method returns multiple values, they will be returned within an array.

The interface object is an event emitter that will emit the name of a signal when it is emitted on the bus. Arguments to the callback should correspond to the arguments of the signal.

This is a brief example of using a proxy object with the [MPRIS](https://specifications.freedesktop.org/mpris-spec/latest/Player_Interface.html) media player interface.

```js
let dbus = require('dbus-next');
let bus = dbus.sessionBus();
let Variant = dbus.Variant;

// getting an object introspects it on the bus and creates the interfaces
let obj = await bus.getProxyObject('org.mpris.MediaPlayer2.vlc', '/org/mpris/MediaPlayer2');

// the interfaces are the primary way of interacting with objects on the bus
let player = obj.getInterface('org.mpris.MediaPlayer2.Player');
let properties = obj.getInterface('org.freedesktop.DBus.Properties');

// call methods on the interface
await player.Play()

// get properties with the properties interface (this returns a variant)
let volumeVariant = await properties.Get('org.mpris.MediaPlayer2.Player', 'Volume');
console.log('current volume: ' + volumeVariant.value);

// set properties with the properties interface using a variant
await properties.Set('org.mpris.MediaPlayer2.Player', 'Volume', new Variant('d', volumeVariant.value + 0.05));

// listen to signals
properties.on('PropertiesChanged', (iface, changed, invalidated) => {
  for (let prop of Object.keys(changed)) {
    console.log(`property changed: ${prop}`);
  }
});
```

For a complete example, see the [MPRIS client](https://github.com/acrisci/node-dbus-next/blob/master/examples/mpris.js) example which can be used to control media players on the command line.

## The New Service Interface

You can use the `Interface` class to define your interfaces. This interfaces uses the proposed [decorators syntax](https://github.com/tc39/proposal-decorators) which is not yet part of the ECMAScript standard, but should be included one day. Unfortunately, you'll need a [Babel plugin](https://www.npmjs.com/package/@babel/plugin-proposal-decorators) to make this code work for now.

```js
let dbus = require('dbus-next');
let Variant = dbus.Variant;

let {
  Interface, property, method, signal, MethodError,
  ACCESS_READ, ACCESS_WRITE, ACCESS_READWRITE
} = dbus.interface;

let bus = dbus.sessionBus();

class ExampleInterface extends Interface {
  @property({signature: 's', access: ACCESS_READWRITE})
  SimpleProperty = 'foo';

  _MapProperty = {
    'foo': new Variant('s', 'bar'),
    'bat': new Variant('i', 53)
  };

  @property({signature: 'a{sv}'})
  get MapProperty() {
    return this._MapProperty;
  }

  set MapProperty(value) {
    this._MapProperty = value;

    this.PropertiesChanged({
      MapProperty: value
    });
  }

  @method({inSignature: 's', outSignature: 's'})
  Echo(what) {
    return what;
  }

  @method({inSignature: 'ss', outSignature: 'vv'})
  ReturnsMultiple(what, what2) {
    return [
      new Variant('s', what),
      new Variant('s', what2)
    ];
  }

  @method({inSignature: '', outSignature: ''})
  ThrowsError() {
    throw new MethodError('org.test.iface.Error', 'something went wrong');
  }

  @signal({signature: 's'})
  HelloWorld(value) {
    return value;
  }

  @signal({signature: 'ss'})
  SignalMultiple(x) {
    return [
      'hello',
      'world'
    ];
  }
}

let example = new ExampleInterface('org.test.iface');

setTimeout(() => {
  // emit the HelloWorld signal
  example.HelloWorld('hello');
}, 500);

bus.export('org.test.name',
           '/org/test/path',
           example);
```

Interfaces extend the `Interface` class. Declare service methods, properties, and signals with the decorators provided from the library. Then call `bus.export()` to export them onto the bus.

Methods are called when a DBus client calls that method on the server. Properties can be gotten and set with the `org.freedesktop.DBus.Properties` interface and are included in the introspection xml.

To emit a signal, just call the method marked with the `signal` decorator and the signal will be emitted with the returned value.

## Links
   - http://cgit.freedesktop.org/dbus - freedesktop reference C library
   - https://github.com/guelfey/go.dbus
   - https://github.com/Shouqun/node-dbus - libdbus
   - https://github.com/Motorola-Mobility/node-dbus - libdbus
   - https://github.com/izaakschroeder/node-dbus - libdbus
   - https://github.com/agnat/node_libdbus
   - https://github.com/agnat/node_dbus - native js
   - https://github.com/cocagne/txdbus - native python + twisted
   - http://search.cpan.org/~danberr/Net-DBus-1.0.0/ (seems to be native, but requires libdbus?)
   - https://github.com/mvidner/ruby-dbus (native, sync)
   - http://www.ndesk.org/DBusSharp (C#/Mono)
   - https://github.com/lizenn/erlang-dbus/ - erlang
   - https://github.com/mspanc/dbux/ - elixir
   - http://0pointer.net/blog/the-new-sd-bus-api-of-systemd.html - Blog post about sb-bus and D-Bus in general
