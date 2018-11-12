let EventEmitter = require('events');
const {
  isInterfaceNameValid,
  isMemberNameValid
} = require('../validators');

class ProxyInterface extends EventEmitter {
  constructor(name, object) {
    super();
    this.$name = name;
    this.$object = object;
    this.$properties = [];
    this.$methods = [];
    this.$signals = [];
  }

  static _fromXml(object, xml) {
    if (!xml.hasOwnProperty('$') || !isInterfaceNameValid(xml['$'].name)) {
      return null;
    }

    let name = xml['$'].name;
    let iface = new ProxyInterface(name, object)

    if (Array.isArray(xml.property)) {
      for (let p of xml.property) {
        // TODO validation
        if (p.hasOwnProperty('$')) {
          iface.$properties.push(p['$']);
        }
      }
    }

    if (Array.isArray(xml.signal)) {
      for (let s of xml.signal) {
        if (!s.hasOwnProperty('$') || !isMemberNameValid(s['$'].name)) {
          continue;
        }
        let signal = {
          name: s['$'].name,
          signature: ''
        };

        if (Array.isArray(s.arg)) {
          for (let a of s.arg) {
            if (a.hasOwnProperty('$') && a['$'].hasOwnProperty('type')) {
              // TODO signature validation
              signal.signature += a['$'].type;
            }
          }
        }

        iface.$signals.push(signal);
      }
    }

    if (Array.isArray(xml.method)) {
      for (let m of xml.method) {
        if (!m.hasOwnProperty('$') || !isMemberNameValid(m['$'].name)) {
          continue;
        }
        let method = {
          name: m['$'].name,
          inSignature: '',
          outSignature: ''
        };

        if (Array.isArray(m.arg)) {
          for (let a of m.arg) {
            if (!a.hasOwnProperty('$') || typeof a['$'].type !== 'string') {
              continue;
            }
            let arg = a['$'];
            if (arg.direction === 'in') {
              method.inSignature += arg.type;
            } else if (arg.direction === 'out') {
              method.outSignature += arg.type;
            }
          }
        }

        // TODO signature validation
        iface.$methods.push(method);

        iface[method.name] = async function(...args) {
          let objArgs = [
            name,
            method.name,
            method.inSignature,
            method.outSignature
          ].concat(args);
          return object.callMethod.apply(object, objArgs);
        }
      }
    }

    return iface;
  }
}

module.exports = ProxyInterface;
