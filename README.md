# dbus-next

The next great DBus library for NodeJS.

*This project is unreleased and is not ready to be used.*

## About

dbus-next is a fork of the wonderful [dbus-native](https://github.com/sidorares/dbus-native) library. While this library is fantastic, it has many bugs which I don't think can be fixed without completely redesigning the user API. Another library exists [node-dbus](https://github.com/Shouqun/node-dbus) which is similar, but this project requires compiling C code and similarly does not provide enough features to create full-featured DBus services.

Here are some goals for the project:

* Update the client interface with a modern ES6 interface
* Redesign the service interface
* Fix some outstanding bugs on the issue tracker

## The Service Interface (Proposed)

You can use the `Interface` class to define your interfaces. This interfaces uses the proposed [decorators syntax](https://github.com/tc39/proposal-decorators) which is not yet part of the ECMAScript standard, but should be included one day. Unfortunately, you'll need a [Babel plugin](https://www.npmjs.com/package/@babel/plugin-proposal-decorators) to make this code work for now.

```js
let dbus = require('dbus-next');
let service = dbus.service;
let Variant = dbus.Variant;

let bus = dbus.sessionBus();

class ExampleInterface extends service.Interface {
  @service.property({signature: 's', access: service.ACCESS_READWRITE})
  StringProperty = 'foo';

  @service.property({signature: 'a{sv}', access: service.ACCESS_READ})
  VariantMapProperty = {
    foo: new Variant('s', 'bar'),
    bat: new Variant('d', 53)
  }

  @service.method({inSignature: 's', outSignature: 's'})
  Echo(what) {
    return what;
  }

  @service.signal({signature: 'd'})
  HelloWorld(x) {
    return x;
  }
}

let example = new ExampleInterface('org.test.iface');

setTimeout(() => {
  // emit the HelloWorld signal
  example.HelloWorld(53);
}, 500);

// export the service on the bus on the given name with the given object path.
bus.export('org.test.name',
           '/org/test/path',
           example);
```

Interfaces extend the `Interface` class. Declare service methods, properties, and signals with the decorators provided from the library. Then call `bus.export()` to export them onto the bus.

Methods are called when a DBus client calls that method on the server. Properties can be gotten and set with the `org.freedesktop.DBus.Properties` interface and are included in the introspection xml.

To emit a signal, just call the method marked with the `signal` decorator and the signal will be emitted with the returned value.

## Contributing

Contributions are welcome. There's alot to do! Look at the issue tracker for [dbus-native](https://github.com/sidorares/dbus-native) for all those tricky bugs that require breaking the interface. I'll be pulling in a lot of outstanding pull requests from the project as well.

TODO:

* Redesign the client interface
* Complete implementation of the server interface
* Fix bugs

## Copyright

You can use this code under an MIT license (see LICENSE).

© Andrey Sidorov 2012
