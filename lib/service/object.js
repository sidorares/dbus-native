const variant = require('./variant');
const Variant = variant.Variant;
let assertObjectPathValid = require('../validators').assertObjectPathValid;

class ServiceObject {
  constructor(path, bus) {
    assertObjectPathValid(path);
    this.path = path;
    this.bus = bus;
    this.interfaces = {};
  }

  addInterface(iface) {
    this.interfaces[iface.$name] = iface;
    let that = this;
    iface.$emitter.on('signal', function(options, result) {
      // TODO lots of repeated code with the method handler here
      let {
        signature,
        signatureTree,
        name
      } = options;
      if (result === undefined) {
        result = [];
      } else if (signatureTree.length === 1) {
        result = [result];
      } else if (!Array.isArray(result)) {
        throw new Error(`signal ${iface.$name}.${name} expected to return multiple arguments in an array (signature: '${signature}')`);
      }

      if (signatureTree.length !== result.length) {
        throw new Error(`signal ${iface.$name}.${name} returned the wrong number of arguments (got ${result.length} expected ${signatureTree.length}) for signature '${signature}'`);
      }

      let body = [];
      for (let i = 0; i < result.length; ++i) {
        if (signatureTree[i].type === 'v') {
          if (result[i].constructor !== Variant) {
            throw new Error(`signal ${iface.$name} expected a Variant() argument for arg ${i+1}`);
          }
          body.push(variant.jsToMarshalFmt(result[i].signature, result[i].value));
        } else {
          body.push(variant.jsToMarshalFmt(signatureTree[i], result[i])[1]);
        }
      }

      that.bus.sendSignal(that.path, iface.$name, name, signature, body);
    });

    iface.$emitter.on('properties-changed', function(changedProperties, invalidatedProperties) {
      let body = [
        iface.$name,
        variant.jsToMarshalFmt('a{sv}', changedProperties)[1],
        variant.jsToMarshalFmt('as', invalidatedProperties)[1]
      ];
      that.bus.sendSignal(that.path, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', 'sa{sv}as', body);
    });
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
        $:{ name: 'org.freedesktop.DBus.Introspectable' },
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
        $:{ name: 'org.freedesktop.DBus.Properties' },
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
              { $: { direction: 'in', type: 'v' } },
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
