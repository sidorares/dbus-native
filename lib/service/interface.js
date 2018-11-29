const parseSignature = require('../signature');
const variant = require('./variant');
const Variant = variant.Variant;
const ACCESS_READ = 'read';
const ACCESS_WRITE = 'write';
const ACCESS_READWRITE = 'readwrite';
const EventEmitter = require('events');
let {
  assertInterfaceNameValid,
  assertMemberNameValid
} = require('../validators');

class MethodError extends Error {
  constructor(type, text) {
    assertInterfaceNameValid(type);
    text = text || '';
    super(text);
    this.name = 'MethodError';
    this.type = type;
    this.text = text;
  }
}

function property(options) {
  options.access = options.access || ACCESS_READWRITE;
  if (!options.signature) {
    throw new Error('missing signature for property');
  }
  options.signatureTree = parseSignature(options.signature);
  return function(descriptor) {
    options.name = descriptor.key;
    assertMemberNameValid(options.name);
    descriptor.finisher = function(klass) {
      klass.prototype.$properties = klass.prototype.$properties || [];
      klass.prototype.$properties[descriptor.key] = options;
    };
    return descriptor;
  };
}

function method(options) {
  // TODO allow overriding of methods?
  // TODO introspect the names of the arguments for the function:
  // https://stackoverflow.com/questions/1007981/how-to-get-function-parameter-names-values-dynamically
  options.inSignature = options.inSignature || '';
  options.outSignature = options.outSignature || '';
  options.inSignatureTree = parseSignature(options.inSignature);
  options.outSignatureTree = parseSignature(options.outSignature);
  return function(descriptor) {
    options.name = descriptor.key;
    assertMemberNameValid(options.name);
    options.fn = descriptor.descriptor.value;
    descriptor.finisher = function(klass) {
      klass.prototype.$methods = klass.prototype.$methods || [];
      klass.prototype.$methods[descriptor.key] = options;
    };
    return descriptor;
  };
}

function signal(options) {
  // TODO introspect the names of the arguments for the function:
  // https://stackoverflow.com/questions/1007981/how-to-get-function-parameter-names-values-dynamically
  options.signature = options.signature || '';
  options.signatureTree = parseSignature(options.signature);
  return function(descriptor) {
    options.name = descriptor.key;
    assertMemberNameValid(options.name);
    options.fn = descriptor.descriptor.value;
    descriptor.descriptor.value = function() {
      let result = options.fn.apply(this, arguments);
      this.$emitter.emit('signal', options, result);
    };
    descriptor.finisher = function(klass) {
      klass.prototype.$signals = klass.prototype.$signals || [];
      klass.prototype.$signals[descriptor.key] = options;
    };
    return descriptor;
  };
}

class Interface {
  constructor(name) {
    assertInterfaceNameValid(name);
    this.$name = name;
    this.$emitter = new EventEmitter();
  }

  PropertiesChanged(changedProperties, invalidatedProperties = []) {
    if (
      !Array.isArray(invalidatedProperties) ||
      !invalidatedProperties.every(p => typeof p === 'string')
    ) {
      throw new Error('invalidated properties must be an array of strings');
    }

    // we transform them to variants here based on property signatures so they
    // don't have to
    let properties = this.$properties || {};
    let changedPropertiesVariants = {};
    for (let p of Object.keys(changedProperties)) {
      if (properties[p] === undefined) {
        throw new Error(`got properties changed with unknown property: ${p}`);
      }
      changedPropertiesVariants[p] = new Variant(
        properties[p].signature,
        changedProperties[p]
      );
    }
    this.$emitter.emit(
      'properties-changed',
      changedPropertiesVariants,
      invalidatedProperties
    );
  }

  $introspect() {
    // TODO cache xml when the interface is declared
    let xml = {
      $: {
        name: this.$name
      }
    };

    const properties = this.$properties || {};
    for (const p of Object.keys(properties) || []) {
      const property = properties[p];
      xml.property = xml.property || [];
      xml.property.push({
        $: {
          name: p,
          type: property.signature,
          access: property.access
        }
      });
    }

    const methods = this.$methods || {};
    for (const m of Object.keys(methods) || []) {
      const method = methods[m];
      xml.method = xml.method || [];
      let methodXml = {
        $: {
          name: m
        },
        arg: []
      };

      for (let signature of method.inSignatureTree) {
        methodXml.arg.push({
          $: {
            direction: 'in',
            type: variant.collapseSignature(signature)
          }
        });
      }

      for (let signature of method.outSignatureTree) {
        methodXml.arg.push({
          $: {
            direction: 'out',
            type: variant.collapseSignature(signature)
          }
        });
      }

      xml.method.push(methodXml);
    }

    const signals = this.$signals || {};
    for (const s of Object.keys(signals) || []) {
      const signal = signals[s];
      xml.signal = xml.signal || [];
      let signalXml = {
        $: {
          name: s
        },
        arg: []
      };

      for (let signature of signal.signatureTree) {
        signalXml.arg.push({
          $: {
            type: variant.collapseSignature(signature)
          }
        });
      }

      xml.signal.push(signalXml);
    }

    return xml;
  }
}

module.exports = {
  ACCESS_READ: ACCESS_READ,
  ACCESS_WRITE: ACCESS_WRITE,
  ACCESS_READWRITE: ACCESS_READWRITE,
  property: property,
  method: method,
  signal: signal,
  Interface: Interface,
  MethodError: MethodError
};
