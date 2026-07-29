const crypto = require('crypto');
const fs = require('fs');

const constants = require('./constants');
const parseSignature = require('./signature');
const properties = require('./properties');
const { variantValue } = require('./values');

// org.freedesktop.DBus.Peer.GetMachineId must return the same 32-char hex id
// for the lifetime of the machine. Prefer the real one written by dbus/systemd,
// and fall back to a per-process id so we still answer with something valid.
let machineId;
function getMachineId() {
  if (machineId) return machineId;
  for (const file of ['/var/lib/dbus/machine-id', '/etc/machine-id']) {
    try {
      const id = fs.readFileSync(file, 'ascii').trim();
      if (id) return (machineId = id);
    } catch {
      // try the next location
    }
  }
  return (machineId = crypto.randomBytes(16).toString('hex'));
}

// TODO: use xmlbuilder

const xmlHeader =
  '<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"\n' +
  '    "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">';

module.exports = function (msg, bus) {
  if (
    msg['interface'] === 'org.freedesktop.DBus.Introspectable' &&
    msg.member === 'Introspect'
  ) {
    if (msg.path === '/') msg.path = '';

    const resultXml = [xmlHeader];
    const nodes = {};
    // TODO: this is not very efficient for large number of exported objects
    // need to build objects tree as they are exported and walk this tree on introspect request
    for (const path in bus.exportedObjects) {
      if (path.indexOf(msg.path) === 0) {
        // objects path starts with requested
        const introspectableObj = bus.exportedObjects[msg.path];
        if (introspectableObj) {
          nodes[msg.path] = introspectableObj;
        } else {
          if (path[msg.path.length] !== '/') continue;
          const localPath = path.substr(msg.path.length);
          const pathParts = localPath.split('/');
          const localName = pathParts[1];
          nodes[localName] = null;
        }
      }
    }

    const length = Object.keys(nodes).length;
    if (length === 0) {
      resultXml.push('<node/>');
    } else if (length === 1) {
      const obj = nodes[Object.keys(nodes)[0]];
      if (obj) {
        resultXml.push('<node>');
        for (const ifaceNode in obj) {
          resultXml.push(interfaceToXML(obj[ifaceNode][0]));
        }
        resultXml.push(stdIfaces);
        resultXml.push('</node>');
      } else {
        resultXml.push(
          `<node>\n  <node name="${Object.keys(nodes)[0]}"/>\n  </node>`
        );
      }
    } else {
      resultXml.push('<node>');
      for (const name in nodes) {
        if (nodes[name] === null) {
          resultXml.push(`  <node name="${name}" />`);
        } else {
          const node = nodes[name];
          resultXml.push(`  <node name="${name}" >`);
          for (const ifaceName in node) {
            resultXml.push(interfaceToXML(node[ifaceName][0]));
          }
          resultXml.push(stdIfaces);
          resultXml.push('  </node>');
        }
      }
      resultXml.push('</node>');
    }

    const introspectableReply = {
      type: constants.messageType.methodReturn,
      serial: bus.serial++,
      replySerial: msg.serial,
      destination: msg.sender,
      signature: 's',
      body: [resultXml.join('\n')]
    };
    bus.connection.message(introspectableReply);
    return 1;
  } else if (msg['interface'] === 'org.freedesktop.DBus.Properties') {
    const interfaceName = msg.body[0];
    const propertiesObj = bus.exportedObjects[msg.path];
    if (!propertiesObj) {
      bus.sendError(
        msg,
        'org.freedesktop.DBus.Error.UnknownObject',
        `No such object path "${msg.path}"`
      );
      return 1;
    }
    if (!propertiesObj[interfaceName]) {
      bus.sendError(
        msg,
        'org.freedesktop.DBus.Error.UnknownInterface',
        `No such interface "${interfaceName}" at object path "${msg.path}"`
      );
      return 1;
    }
    const impl = propertiesObj[interfaceName][1];

    const propertiesReply = {
      type: constants.messageType.methodReturn,
      serial: bus.serial++,
      replySerial: msg.serial,
      destination: msg.sender
    };
    const ifaceDesc = propertiesObj[interfaceName][0];

    if (msg.member === 'Get' || msg.member === 'Set') {
      const propertyName = msg.body[1];
      let decl;
      try {
        decl = properties.declaration(ifaceDesc, propertyName);
      } catch (e) {
        // A malformed declaration is the service's bug, not the caller's, but
        // the caller is the one waiting for a reply.
        bus.sendError(msg, 'org.freedesktop.DBus.Error.Failed', e.message);
        return 1;
      }
      if (decl === undefined) {
        bus.sendError(
          msg,
          'org.freedesktop.DBus.Error.UnknownProperty',
          `No such property "${propertyName}" on interface "${interfaceName}"`
        );
        return 1;
      }
      if (msg.member === 'Get') {
        if (!properties.isReadable(decl.access)) {
          bus.sendError(
            msg,
            'org.freedesktop.DBus.Error.AccessDenied',
            `Property "${propertyName}" on interface "${interfaceName}" is write-only`
          );
          return 1;
        }
        const propValue = impl[propertyName];
        propertiesReply.signature = 'v';
        propertiesReply.body = [[decl.type, propValue]];
      } else {
        if (!properties.isWritable(decl.access)) {
          bus.sendError(
            msg,
            'org.freedesktop.DBus.Error.PropertyReadOnly',
            `Property "${propertyName}" on interface "${interfaceName}" is read-only`
          );
          return 1;
        }
        // Set takes (interface_name, property_name, value) where the value is
        // a variant. Read through variantValue() rather than by index: this
        // runs on a message the library parsed with the connection's own
        // options, so it has to keep working when a value-shape option makes
        // an unmarshalled variant the plain value instead of [tree, [value]].
        const value = variantValue(msg.body[2]);
        impl[propertyName] = value;
        // Tell subscribers. A write-only property has no value to broadcast,
        // so it is reported as invalidated instead -- which is what the spec
        // wants, rather than leaving subscribers with a stale value.
        if (properties.isReadable(decl.access)) {
          bus.emitPropertiesChanged(msg.path, interfaceName, {
            [propertyName]: value
          });
        } else {
          bus.emitPropertiesChanged(msg.path, interfaceName, {}, [
            propertyName
          ]);
        }
      }
    } else if (msg.member === 'GetAll') {
      propertiesReply.signature = 'a{sv}';
      const props = [];
      for (const p of properties.names(ifaceDesc)) {
        let decl;
        try {
          decl = properties.declaration(ifaceDesc, p);
        } catch (e) {
          bus.sendError(msg, 'org.freedesktop.DBus.Error.Failed', e.message);
          return 1;
        }
        // GetAll returns what can be read; a write-only property has no value
        // to report and the spec says to leave it out rather than guess.
        if (!properties.isReadable(decl.access)) continue;
        props.push([p, [decl.type, impl[p]]]);
      }
      propertiesReply.body = [props];
    }
    bus.connection.message(propertiesReply);
    return 1;
  } else if (msg['interface'] === 'org.freedesktop.DBus.Peer') {
    // TODO: implement bus.replyTo(srcMsg, signature, body) method
    const peerReply = {
      type: constants.messageType.methodReturn,
      serial: bus.serial++,
      replySerial: msg.serial,
      destination: msg.sender
    };
    if (msg.member === 'Ping') {
      // empty body
    } else if (msg.member === 'GetMachineId') {
      peerReply.signature = 's';
      peerReply.body = [getMachineId()];
    }
    bus.connection.message(peerReply);
    return 1;
  }
  return 0;
};

// TODO: move to introspect.js
function interfaceToXML(iface) {
  const result = [];
  const dumpArgs = function (argsSignature, argsNames, direction) {
    if (!argsSignature) return;
    const args = parseSignature(argsSignature);
    args.forEach((arg, num) => {
      const argName = argsNames ? argsNames[num] : direction + num;
      const dirStr = direction === 'signal' ? '' : `" direction="${direction}`;
      result.push(
        `      <arg type="${dumpSignature([arg])}" name="${argName}${
          dirStr
        }" />`
      );
    });
  };
  result.push(`  <interface name="${iface.name}">`);
  if (iface.methods) {
    for (const methodName in iface.methods) {
      const method = iface.methods[methodName];
      result.push(`    <method name="${methodName}">`);
      dumpArgs(method[0], method[2], 'in');
      dumpArgs(method[1], method[3], 'out');
      result.push('    </method>');
    }
  }
  if (iface.signals) {
    for (const signalName in iface.signals) {
      const signal = iface.signals[signalName];
      result.push(`    <signal name="${signalName}">`);
      dumpArgs(signal[0], signal.slice(1), 'signal');
      result.push('    </signal>');
    }
  }
  for (const propertyName of properties.names(iface)) {
    const decl = properties.declaration(iface, propertyName);
    result.push(
      `    <property name="${propertyName}" type="${decl.type}" access="${
        decl.access
      }"/>`
    );
  }
  result.push('  </interface>');
  return result.join('\n');
}

function dumpSignature(s) {
  const result = [];
  s.forEach(sig => {
    result.push(sig.type + dumpSignature(sig.child));
    if (sig.type === '{') result.push('}');
    if (sig.type === '(') result.push(')');
  });
  return result.join('');
}
const stdIfaces =
  '  <interface name="org.freedesktop.DBus.Properties">\n    <method name="Get">\n      <arg type="s" name="interface_name" direction="in"/>\n      <arg type="s" name="property_name" direction="in"/>\n      <arg type="v" name="value" direction="out"/>\n    </method>\n    <method name="GetAll">\n      <arg type="s" name="interface_name" direction="in"/>\n      <arg type="a{sv}" name="properties" direction="out"/>\n    </method>\n    <method name="Set">\n      <arg type="s" name="interface_name" direction="in"/>\n      <arg type="s" name="property_name" direction="in"/>\n      <arg type="v" name="value" direction="in"/>\n    </method>\n    <signal name="PropertiesChanged">\n      <arg type="s" name="interface_name"/>\n      <arg type="a{sv}" name="changed_properties"/>\n      <arg type="as" name="invalidated_properties"/>\n    </signal>\n  </interface>\n  <interface name="org.freedesktop.DBus.Introspectable">\n    <method name="Introspect">\n      <arg type="s" name="xml_data" direction="out"/>\n    </method>\n  </interface>\n  <interface name="org.freedesktop.DBus.Peer">\n    <method name="Ping"/>\n    <method name="GetMachineId">\n      <arg type="s" name="machine_uuid" direction="out"/>\n    </method>\n  </interface>';
