const variant = require('./variant');
const Variant = variant.Variant;
let {
  isObjectPathValid,
  isInterfaceNameValid,
  isMemberNameValid
} = require('../validators');

const {
  ACCESS_READ,
  ACCESS_WRITE,
  ACCESS_READWRITE
} = require('./interface');

const INVALID_ARGS = 'org.freedesktop.DBus.Error.InvalidArgs';

function handleIntrospect(bus, msg, name, path) {
  bus.sendReply(msg, 's', [name.introspect(path)]);
}

function handleGetProperty(bus, msg, name, path) {
  let [ifaceName, prop] = msg.body;
  let obj = name.getObject(path);
  let iface = obj.interfaces[ifaceName];
  // TODO An empty string may be provided for the interface name; in this case,
  // if there are multiple properties on an object with the same name, the
  // results are undefined (picking one by according to an arbitrary
  // deterministic rule, or returning an error, are the reasonable
  // possibilities).
  if (!iface) {
    bus.sendError(msg, INVALID_ARGS, `No such interface: '${ifaceName}'`);
    return;
  }

  let properties = iface.$properties || {};

  let property = properties[prop];
  if (property === undefined) {
    bus.sendError(msg, INVALID_ARGS, `No such property: '${prop}'`);
    return;
  }

  let propertyValue = iface[prop];
  if (propertyValue === undefined) {
    throw new Error('tried to get a property that is not set: ' + prop);
  }

  if (!(property.access === ACCESS_READWRITE ||
      property.access === ACCESS_READ)) {
    bus.sendError(msg, INVALID_ARGS, `Property does not have read access: '${prop}'`);
  }

  let body = variant.jsToMarshalFmt(property.signature, propertyValue);

  bus.sendReply(msg, 'v', [body]);
}

function handleGetAllProperties(bus, msg, name, path) {
  let ifaceName = msg.body[0];

  let obj = name.getObject(path);
  let iface = obj.interfaces[ifaceName];

  let result = {};
  if (iface) {
    let properties = iface.$properties || {};
    for (let k of Object.keys(properties)) {
      let p = properties[k];
      let value = iface[k];
      if (value === undefined) {
        throw new Error('tried to get a property that is not set: ' + p);
      }

      if (p.access === ACCESS_READ || p.access === ACCESS_READWRITE) {
        result[k] = new Variant(p.signature, value);
      }
    }
  }

  let body = variant.jsToMarshalFmt('a{sv}', result)[1];
  bus.sendReply(msg, 'a{sv}', [body]);
}

function handleSetProperty(bus, msg, name, path) {
  let [ifaceName, prop, value] = msg.body;

  let obj = name.getObject(path);
  let iface = obj.interfaces[ifaceName];

  if (!iface) {
    bus.sendError(msg, INVALID_ARGS, `Interface not found: '${ifaceName}'`);
    return;
  }

  let properties = iface.$properties || {};
  if (!properties.hasOwnProperty(prop)) {
    bus.sendError(msg, INVALID_ARGS, `No such property: '${prop}'`);
    return;
  }

  let property = properties[prop];

  if (!(property.access === ACCESS_WRITE || property.access === ACCESS_READWRITE)) {
    bus.sendError(msg, INVALID_ARGS, `Property does not have write access: '${prop}'`);
  }

  let valueSignature = variant.collapseSignature(value[0][0])
  if (valueSignature !== property.signature) {
    bus.sendError(msg, INVALID_ARGS, `Cannot set property '${prop}' with signature '${valueSignature}' (expected '${properties[prop].signature}')`);
    return;
  }

  iface[prop] = variant.parse(value);
  bus.sendReply(msg, '', []);
}

function handleStdIfaces(bus, msg, name) {
  let {
    member,
    path,
    signature
  } = msg;

  let ifaceName = msg.interface;

  if (!isInterfaceNameValid(ifaceName)) {
    bus.sendError(msg, INVALID_ARGS, `Invalid interface name: '${ifaceName}'`);
    return true;
  }

  if (!isMemberNameValid(member)) {
    bus.sendError(msg, INVALID_ARGS, `Invalid member name: '${member}'`);
    return true;
  }

  if (!isObjectPathValid(path)) {
    bus.sendError(msg, INVALID_ARGS, `Invalid path name: '${path}'`);
    return true;
  }

  if (ifaceName === 'org.freedesktop.DBus.Introspectable' &&
        member === 'Introspect' &&
        !signature) {
    handleIntrospect(bus, msg, name, path);
    return true;
  } else if (ifaceName === 'org.freedesktop.DBus.Properties') {
    if (member === 'Get' && signature === 'ss') {
      handleGetProperty(bus, msg, name, path);
      return true;
    } else if (member === 'Set' && signature === 'ssv') {
      handleSetProperty(bus, msg, name, path);
      return true;
    } else if (member === 'GetAll') {
      handleGetAllProperties(bus, msg, name, path);
      return true;
    }
  }

  return false;
}

module.exports = function(msg, bus) {
  let {
    path,
    member,
    destination,
    signature
  } = msg;

  let ifaceName = msg.interface;

  signature = signature || '';

  if (Object.keys(bus._names) === 0) {
    // no names registered
    return false;
  }

  let name = bus._names[destination];

  if (!name) {
    if (destination[0] === ':') {
      // TODO: they didn't include a name as the destination, but the
      // address of the server (d-feet does this). not sure how to handle
      // this with multiple names. Just pick the first one until we figure it
      // out.
      name = bus._names[Object.keys(bus._names)[0]];

      if (!name) {
        return false;
      }
    }
  }

  if (handleStdIfaces(bus, msg, name)) {
    return true;
  }

  let obj = name.getObject(path);
  let iface = obj.interfaces[ifaceName];

  if (!iface) {
    return false;
  }

  let methods = iface.$methods || {};
  for (let m of Object.keys(methods)) {
    let method = methods[m];
    if (m === member && method.inSignature === signature) {
      let args = [];
      for (let i = 0; i < method.inSignatureTree.length; ++i) {
        let bodyArg = msg.body[i];
        let bodyArgSignature = method.inSignatureTree[i];
        args.push(variant.parse([[bodyArgSignature], [bodyArg]]));
      }
      let result = null;
      try {
        result = method.fn.apply(iface, args);
      } catch (e) {
        if (e.name === 'MethodError') {
          bus.sendError(msg, e.type, e.text);
          return true;
        } else {
          throw e;
        }
      }
      if (result === undefined) {
        result = [];
      } else if (method.outSignatureTree.length === 1) {
        result = [result];
      } else if (!Array.isArray(result)) {
        throw new Error(`method ${iface.$name}.${m} expected to return multiple arguments in an array (signature: '${method.outSignature}')`);
      }

      if (method.outSignatureTree.length !== result.length) {
        throw new Error(`method ${iface.$name}.${m} returned the wrong number of arguments (got ${result.length} expected ${method.outSignatureTree.length}) for signature '${method.outSignature}'`);
      }

      let body = [];

      for (let i = 0; i < result.length; ++i) {
        if (method.outSignatureTree[i].type === 'v') {
          if (result[i].constructor !== Variant) {
            throw new Error(`signal ${iface.$name} expected a Variant() argument for arg ${i+1}`);
          }
          body.push(variant.jsToMarshalFmt(result[i].signature, result[i].value));
        } else {
          body.push(variant.jsToMarshalFmt(method.outSignatureTree[i], result[i])[1]);
        }
      }
      bus.sendReply(msg, method.outSignature, body);
      return true;
    }
  }

  return false;
};
