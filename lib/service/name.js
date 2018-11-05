const ServiceObject = require('./object');
const xml2js = require('xml2js');
const assertObjectPathValid = require('../validators').assertObjectPathValid;

const xmlHeader = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">\n`

class Name {
  constructor(bus) {
    this.bus = bus;
    this.objects = {};
    this.builder = new xml2js.Builder({ headless: true });
  }

  getObject(path) {
    assertObjectPathValid(path);
    if (!this.objects[path]) {
      this.objects[path] = new ServiceObject(path, this.bus);
    }
    return this.objects[path];
  }

  introspect(path) {
    assertObjectPathValid(path);
    let xml = {
      node: {
        node: []
      }
    };

    if (this.objects[path]) {
      xml.node.interface = this.objects[path].introspect();
    }

    let pathSplit = path.split('/').filter(n => n);

    for (let key of Object.keys(this.objects)) {
      let keySplit = key.split('/').filter(n => n);
      if (keySplit.length <= pathSplit.length) {
        continue;
      }
      if (pathSplit.every((v, i) => v === keySplit[i])) {
        let child = keySplit[pathSplit.length];
        xml.node.node.push({
          $: {
            name: child
          }
        });
      }
    }

    return xmlHeader + this.builder.buildObject(xml);
  }
}

module.exports = Name;
