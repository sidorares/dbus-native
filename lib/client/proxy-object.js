const xml2js = require('xml2js');
const parseSignature = require('../signature');
const ProxyInterface = require('./proxy-interface');
const variant = require('../service/variant');
const Variant = variant.Variant;
const { MethodError } = require('../service/interface');
const {
  assertInterfaceNameValid,
  assertObjectPathValid,
  isObjectPathValid,
  isInterfaceNameValid
} = require('../validators');

class ProxyObject {
  constructor(bus, name, path) {
    assertInterfaceNameValid(name);
    assertObjectPathValid(path);
    this.bus = bus;
    this.name = name;
    this.path = path;
    this.nodes = [];
    this.interfaces = [];
    this._parser = new xml2js.Parser();
  }

  _initXml(xml) {
    let root = xml.node;

    if (Array.isArray(root.node)) {
      for (let n of root.node) {
        if (!n.hasOwnProperty('$')) {
          continue;
        }
        let name = n['$'].name;
        let path = `${this.path}/${name}`;
        if (isObjectPathValid(path)) {
          this.nodes.push(path);
        }
      }
    }

    if (Array.isArray(root.interface)) {
      for (let i of root.interface) {
        let iface = ProxyInterface._fromXml(this, i);
        if (iface !== null) {
          this.interfaces.push(iface);
          this.bus.addMatch(`type='signal',interface='${iface.$name}',path='${this.path}'`);
          for (let signal of iface.$signals) {
            let event = JSON.stringify({
              path: this.path,
              interface: iface.$name,
              member: signal.name
            });
            this.bus.signals.on(event, (body, signature) => {
              if (signature !== signal.signature) {
                console.error(`warning: got signature ${signature} for signal ${iface.$name}.${signal.name} (expected ${signal.signature})`);
                return;
              }
              // TODO refactor this into a method
              let result = [];
              let signatureTree = parseSignature(signature);
              for (let i = 0; i < signatureTree.length; ++i) {
                let tree = signatureTree[i];
                result.push(variant.parse([[tree], [body[i]]]));
              }
              iface.emit.apply(iface, [signal.name].concat(result));
            });
          }
        }
      }
    }
  }

  async _init() {
    return new Promise((resolve, reject) => {
      this.bus.invoke(
        {
          destination: this.name,
          path: this.path,
          interface: 'org.freedesktop.DBus.Introspectable',
          member: 'Introspect',
          signature: '',
          body: []
        },
        (err, xml) => {
          if (err) {
            reject(err);
            return;
          }

          this._parser.parseString(xml, (err, data) => {
            if (err) {
              reject(err);
              return;
            }
            this._initXml(data);
            resolve(this);
          });
        }
      );
    });
  }

  getInterface(name) {
    return this.interfaces.find((i) => i.$name === name);
  }

  async callMethod(iface, member, inSignature, outSignature, ...args) {
    args = args || [];

    // TODO refactor this into a method
    let inSignatureTree = parseSignature(inSignature);
    let body = [];
    for (let i = 0; i < args.length; ++i) {
      if (inSignatureTree[i].type === 'v') {
        if (args[i].constructor !== Variant) {
          throw new Error(`method call ${iface}.${member} expected a Variant() argument for arg ${i+1}`);
        }
        body.push(variant.jsToMarshalFmt(args[i].signature, args[i].value));
      } else {
        body.push(variant.jsToMarshalFmt(inSignatureTree[i], args[i])[1]);
      }
    }

    let msg = {
      member: member,
      signature: inSignature,
      destination: this.name,
      path: this.path,
      interface: iface,
      body: body
    };

    return new Promise((resolve, reject) => {
      this.bus.invoke(msg, function(err, ...busResult) {
        if (err) {
          if (this.message && this.message.hasOwnProperty('errorName')) {
            reject(new MethodError(this.message.errorName, err[0]));
          } else {
            reject(err);
          }
          return;
        }
        // TODO refactor this into a method
        let result = [];
        let outSignatureTree = parseSignature(outSignature);
        if (outSignatureTree.length === 0) {
          resolve(null);
          return;
        }
        for (let i = 0; i < outSignatureTree.length; ++i) {
          let tree = outSignatureTree[i];
          result.push(variant.parse([[tree], [busResult[i]]]));
        }
        if (outSignatureTree.length === 1) {
          resolve(result[0]);
        } else {
          resolve(result);
        }
      });
    });
  }
}

module.exports = ProxyObject;
