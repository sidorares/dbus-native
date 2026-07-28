const crypto = require('crypto');
const fs = require('fs');

const constants = require('./constants');
const parseSignature = require('./signature');

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
    if (msg.member === 'Get' || msg.member === 'Set') {
      const propertyName = msg.body[1];
      const propType = propertiesObj[interfaceName][0].properties[propertyName];
      if (propType === undefined) {
        bus.sendError(
          msg,
          'org.freedesktop.DBus.Error.UnknownProperty',
          `No such property "${propertyName}" on interface "${interfaceName}"`
        );
        return 1;
      }
      if (msg.member === 'Get') {
        const propValue = impl[propertyName];
        propertiesReply.signature = 'v';
        propertiesReply.body = [[propType, propValue]];
      } else {
        // Set takes (interface_name, property_name, value) where the value is a
        // variant. An unmarshalled variant is [signatureTree, [value]], so the
        // value we want to assign lives at body[2][1][0].
        impl[propertyName] = msg.body[2][1][0];
      }
    } else if (msg.member === 'GetAll') {
      propertiesReply.signature = 'a{sv}';
      const props = [];
      for (const p in propertiesObj[interfaceName][0].properties) {
        const propertySignature = propertiesObj[interfaceName][0].properties[p];
        props.push([p, [propertySignature, impl[p]]]);
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
  if (iface.properties) {
    for (const propertyName in iface.properties) {
      // TODO: decide how to encode access
      result.push(
        `    <property name="${propertyName}" type="${
          iface.properties[propertyName]
        }" access="readwrite"/>`
      );
    }
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
