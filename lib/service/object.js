const variant = require('./variant');
const Variant = variant.Variant;
let assertObjectPathValid = require('../validators').assertObjectPathValid;

class ServiceObject {
  constructor(path, bus) {
    assertObjectPathValid(path);
    this.path = path;
    this.bus = bus;
    this.interfaces = {};
    this._handlers = {};
  }

  addInterface(iface) {
    if (this.interfaces[iface.$name]) {
      throw new Error(
        `an interface with name '${
          iface.$name
        }' is already exported on this object`
      );
    }
    this.interfaces[iface.$name] = iface;
    let that = this;

    let propertiesChangedHandler = function(
      changedProperties,
      invalidatedProperties
    ) {
      let body = [
        iface.$name,
        variant.jsToMarshalFmt('a{sv}', changedProperties)[1],
        variant.jsToMarshalFmt('as', invalidatedProperties)[1]
      ];
      that.bus.sendSignal(
        that.path,
        'org.freedesktop.DBus.Properties',
        'PropertiesChanged',
        'sa{sv}as',
        body
      );
    };

    let signalHandler = function(options, result) {
      // TODO lots of repeated code with the method handler here
      let { signature, signatureTree, name } = options;
      if (result === undefined) {
        result = [];
      } else if (signatureTree.length === 1) {
        result = [result];
      } else if (!Array.isArray(result)) {
        throw new Error(
          `signal ${
            iface.$name
          }.${name} expected to return multiple arguments in an array (signature: '${signature}')`
        );
      }

      if (signatureTree.length !== result.length) {
        throw new Error(
          `signal ${
            iface.$name
          }.${name} returned the wrong number of arguments (got ${
            result.length
          } expected ${signatureTree.length}) for signature '${signature}'`
        );
      }

      let body = [];
      for (let i = 0; i < result.length; ++i) {
        if (signatureTree[i].type === 'v') {
          if (result[i].constructor !== Variant) {
            throw new Error(
              `signal ${iface.$name} expected a Variant() argument for arg ${i +
                1}`
            );
          }
          body.push(
            variant.jsToMarshalFmt(result[i].signature, result[i].value)
          );
        } else {
          body.push(variant.jsToMarshalFmt(signatureTree[i], result[i])[1]);
        }
      }

      that.bus.sendSignal(that.path, iface.$name, name, signature, body);
    };

    this._handlers[iface.$name] = {
      propertiesChanged: propertiesChangedHandler,
      signal: signalHandler
    };

    iface.$emitter.on('signal', signalHandler);
    iface.$emitter.on('properties-changed', propertiesChangedHandler);
  }

  removeInterface(iface) {
    if (!this.interfaces[iface.$name]) {
      throw new Error(`Interface ${iface.$name} not exported on this object`);
    }
    let handlers = this._handlers[iface.$name];
    iface.$emitter.removeListener('signal', handlers.signal);
    iface.$emitter.removeListener(
      'properties-changed',
      handlers.propertiesChanged
    );
    delete this._handlers[iface.$name];
    delete this.interfaces[iface.$name];
  }

  introspect() {
    let interfaces = ServiceObject.defaultInterfaces();

    for (let i of Object.keys(this.interfaces)) {
      let iface = this.interfaces[i];
      interfaces.push(iface.$introspect());
    }

    return interfaces;
  }

  static defaultInterfaces() {
    return [
      {
        $: { name: 'org.freedesktop.DBus.Introspectable' },
        method: [
          {
            $: { name: 'Introspect' },
            arg: [
              {
                $: { name: 'data', direction: 'out', type: 's' }
              }
            ]
          }
        ]
      },
      {
        $: { name: 'org.freedesktop.DBus.Properties' },
        method: [
          {
            $: { name: 'Get' },
            arg: [
              { $: { direction: 'in', type: 's' } },
              { $: { direction: 'in', type: 's' } },
              { $: { direction: 'out', type: 'v' } }
            ]
          },
          {
            $: { name: 'Set' },
            arg: [
              { $: { direction: 'in', type: 's' } },
              { $: { direction: 'in', type: 's' } },
              { $: { direction: 'in', type: 'v' } }
            ]
          },
          {
            $: { name: 'GetAll' },
            arg: [
              { $: { direction: 'in', type: 's' } },
              { $: { direction: 'out', type: 'a{sv}' } }
            ]
          }
        ],
        signal: [
          {
            $: { name: 'PropertiesChanged' },
            arg: [
              { $: { type: 's' } },
              { $: { type: 'a{sv}' } },
              { $: { type: 'as' } }
            ]
          }
        ]
      }
    ];
  }
}

module.exports = ServiceObject;
