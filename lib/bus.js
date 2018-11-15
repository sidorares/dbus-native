const EventEmitter = require('events').EventEmitter;
const constants = require('./constants');
const stdDbusIfaces = require('./stdifaces');
const handleMethod = require('./service/handlers');
const introspect = require('./introspect').introspectBus;

// new
const Name = require('./service/name');
let {
  assertInterfaceNameValid,
  assertObjectPathValid
} = require('./validators');
let ProxyObject = require('./client/proxy-object');
let { Interface } = require('./service/interface');

module.exports = function bus(conn, opts) {
  if (!(this instanceof bus)) {
    return new bus(conn);
  }
  if (!opts) opts = {};

  var self = this;
  this.connection = conn;
  this.serial = 1;
  this.cookies = {}; // TODO: rename to methodReturnHandlers
  this.methodCallHandlers = {};
  this.signals = new EventEmitter();
  this.exportedObjects = {};

  this.invoke = function(msg, callback) {
    if (!msg.type) msg.type = constants.messageType.methodCall;
    msg.serial = self.serial++;
    this.cookies[msg.serial] = callback;
    self.connection.message(msg);
  };

  this.invokeDbus = function(msg, callback) {
    if (!msg.path) msg.path = '/org/freedesktop/DBus';
    if (!msg.destination) msg.destination = 'org.freedesktop.DBus';
    if (!msg['interface']) msg['interface'] = 'org.freedesktop.DBus';
    self.invoke(msg, callback);
  };

  this.mangle = function(path, iface, member) {
    var obj = {};
    if (typeof path === 'object') {
      // handle one argumant case mangle(msg)
      obj.path = path.path;
      obj['interface'] = path['interface'];
      obj.member = path.member;
    } else {
      obj.path = path;
      obj['interface'] = iface;
      obj.member = member;
    }
    return JSON.stringify(obj);
  };

  this.sendSignal = function(path, iface, name, signature, args) {
    var signalMsg = {
      type: constants.messageType.signal,
      serial: self.serial++,
      interface: iface,
      path: path,
      member: name
    };
    if (signature) {
      signalMsg.signature = signature;
      signalMsg.body = args;
    }
    self.connection.message(signalMsg);
  };

  // Warning: errorName must respect the same rules as interface names (must contain a dot)
  this.sendError = function(msg, errorName, errorText) {
    var reply = {
      type: constants.messageType.error,
      serial: self.serial++,
      replySerial: msg.serial,
      destination: msg.sender,
      errorName: errorName,
      signature: 's',
      body: [errorText]
    };
    this.connection.message(reply);
  };

  this.sendReply = function(msg, signature, body) {
    var reply = {
      type: constants.messageType.methodReturn,
      serial: self.serial++,
      replySerial: msg.serial,
      destination: msg.sender,
      signature: signature,
      body: body
    };
    this.connection.message(reply);
  };

  // route reply/error
  this.connection.on('message', function(msg) {
    function invoke(impl, func, resultSignature) {
      Promise.resolve()
        .then(function() {
          return func.apply(impl, (msg.body || []).concat(msg));
        })
        .then(
          function(methodReturnResult) {
            var methodReturnReply = {
              type: constants.messageType.methodReturn,
              serial: self.serial++,
              destination: msg.sender,
              replySerial: msg.serial
            };
            if (methodReturnResult !== null) {
              methodReturnReply.signature = resultSignature;
              methodReturnReply.body = [methodReturnResult];
            }
            self.connection.message(methodReturnReply);
          },
          function(e) {
            self.sendError(
              msg,
              e.dbusName || 'org.freedesktop.DBus.Error.Failed',
              e.message || ''
            );
          }
        );
    }

    var handler;
    if (
      msg.type === constants.messageType.methodReturn ||
      msg.type === constants.messageType.error
    ) {
      handler = self.cookies[msg.replySerial];
      if (handler) {
        delete self.cookies[msg.replySerial];
        var props = {
          connection: self.connection,
          bus: self,
          message: msg,
          signature: msg.signature
        };
        var args = msg.body || [];
        if (msg.type === constants.messageType.methodReturn) {
          args = [null].concat(args); // first argument - no errors, null
          handler.apply(props, args); // body as array of arguments
        } else {
          handler.call(props, args); // body as first argument
        }
      }
    } else if (msg.type === constants.messageType.signal) {
      self.signals.emit(self.mangle(msg), msg.body, msg.signature);
    } else {
      // methodCall
      if (handleMethod(msg, self)) {
        return;
      }
      if (stdDbusIfaces(msg, self)) {
        return;
      }

      // exported interfaces handlers
      var obj, iface, impl;
      if ((obj = self.exportedObjects[msg.path])) {
        if ((iface = obj[msg['interface']])) {
          // now we are ready to serve msg.member
          impl = iface[1];
          var func = impl[msg.member];
          if (!func) {
            self.sendError(
              msg,
              'org.freedesktop.DBus.Error.UnknownMethod',
              `Method "${msg.member}" on interface "${msg.interface}" doesn't exist`
            );
            return;
          }
          // TODO safety check here
          var resultSignature = iface[0].methods[msg.member][1];
          invoke(impl, func, resultSignature);
          return;
        } else {
          console.error(`Interface ${msg['interface']} is not supported`);
          // TODO: respond with standard dbus error
        }
      }
      // setMethodCall handlers
      handler = self.methodCallHandlers[self.mangle(msg)];
      if (handler) {
        invoke(null, handler[0], handler[1]);
      } else {
        self.sendError(
          msg,
          'org.freedesktop.DBus.Error.UnknownService',
          'Uh oh oh'
        );
      }
    }
  });

  this.setMethodCallHandler = function(objectPath, iface, member, handler) {
    var key = self.mangle(objectPath, iface, member);
    self.methodCallHandlers[key] = handler;
  };

  // new
  this._nameRequests = {};
  this._names = {};
  this._releaseRequests = {};

  // new
  this.export = async function(name, path, iface) {
    assertInterfaceNameValid(name);
    assertObjectPathValid(path);
    let that = this;

    if (this._releaseRequests[name]) {
      await this._releaseRequests[name];
    }

    if (this._nameRequests[name]) {
      let request = this._nameRequests[name];
      request.then(() => {
        if (that._names[name]) {
          let obj = that._names[name].getObject(path);
          obj.addInterface(iface);
        }
      });
      return request;
    }

    this._nameRequests[name] = new Promise((resolve, reject) => {
      if (!that._names[name]) {
        that.requestName(name, 0, (err, result) => {
          if (err) {
            delete that._nameRequests[name];
            reject(err);
          } else {
            that._names = that._names || {};
            that._names[name] = new Name(that);
            let obj = that._names[name].getObject(path);
            // TODO error interface already added at this path
            obj.addInterface(iface);
            resolve();
          }
        });
      }
    });

    return this._nameRequests[name];
  }

  // new
  this.unexportName = async function(name) {
    assertInterfaceNameValid(name);

    if (!this._names[name]) {
      return new Promise().resolve();
    }

    if (this._releaseRequests[name]) {
      return this._releaseRequests[name];
    }

    if (this._nameRequests[name]) {
      await this._nameRequests[name];
    }
    let nameRequest = this._nameRequests[name];
    delete this._nameRequests[name];

    let nameObj = this._names[name];
    let that = this;

    this._releaseRequests[name] = new Promise((resolve, reject) => {
      let nameRequest = that._nameRequests[name];
      that.releaseName(name, (err) => {
        delete that._releaseRequests[name];
        if (err) {
          // XXX this is a difficult case to get right
          that._nameRequests[name] = nameRequest;
          reject(err);
        }

        for (let o of Object.keys(nameObj.objects)) {
          nameObj.removeObject(o);
        }

        delete that._names[name];
        resolve();
      });
    });

    return this._releaseRequests[name];
  }

  // new
  this.unexportPath = function(name, path) {
    assertInterfaceNameValid(name);
    assertObjectPathValid(path);
    if (!this._names[name]) {
      return;
    }
    this._names[name].removeObject(path);
  }

  // new
  this.unexportInterface = async function(name, path, iface) {
    assertInterfaceNameValid(name);
    assertObjectPathValid(path);
    if (!(iface instanceof Interface)) {
      throw new Error(`Expected a service Interface() for argument 3`);
    }
    if (!this._names[name]) {
      return;
    }

    let nameObj = this._names[name];

    let obj = nameObj.getObject(path);
    obj.removeInterface(iface);
    if (Object.keys(obj.interfaces).length === 0) {
      nameObj.removeObject(path);
    }
  }

  // new
  this.getProxyObject = async function(name, path) {
    let obj = new ProxyObject(this, name, path);
    return obj._init();
  };

  this.exportInterface = function(obj, path, iface) {
    var entry;
    if (!self.exportedObjects[path]) {
      entry = self.exportedObjects[path] = {};
    } else {
      entry = self.exportedObjects[path];
    }
    entry[iface.name] = [iface, obj];
    // monkey-patch obj.emit()
    if (typeof obj.emit === 'function') {
      var oldEmit = obj.emit;
      obj.emit = function() {
        var args = Array.prototype.slice.apply(arguments);
        var signalName = args[0];
        if (!signalName) throw new Error('Trying to emit undefined signa');

        //send signal to bus
        var signal;
        if (iface.signals && iface.signals[signalName]) {
          signal = iface.signals[signalName];
          var signalMsg = {
            type: constants.messageType.signal,
            serial: self.serial++,
            interface: iface.name,
            path: path,
            member: signalName
          };
          if (signal[0]) {
            signalMsg.signature = signal[0];
            signalMsg.body = args.slice(1);
          }
          self.connection.message(signalMsg);
          self.serial++;
        }
        // note that local emit is likely to be called before signal arrives
        // to remote subscriber
        oldEmit.apply(obj, args);
      };
    }
    // TODO: emit ObjectManager's InterfaceAdded
  };

  // register name
  if (opts.direct !== true) {
    this.invokeDbus({ member: 'Hello' }, function(err, name) {
      if (err) throw new Error(err);
      self.name = name;
    });
  } else {
    self.name = null;
  }

  function DBusObject(name, service) {
    this.name = name;
    this.service = service;
    this.as = function(name) {
      return this.proxy[name];
    };
  }

  function DBusService(name, bus) {
    this.name = name;
    this.bus = bus;
    this.getObject = function(name, callback) {
      if(name==undefined)
        return callback(new Error('Object name is null or undefined'));
      var obj = new DBusObject(name, this);
      introspect(obj, function(err, ifaces, nodes) {
        if (err) return callback(err);
        obj.proxy = ifaces;
        obj.nodes = nodes;
        callback(null, obj);
      });
    };

    this.getInterface = function(objName, ifaceName, callback) {
      this.getObject(objName, function(err, obj) {
        if (err) return callback(err);
        callback(null, obj.as(ifaceName));
      });
    };
  }

  this.getService = function(name) {
    return new DBusService(name, this);
  };

  this.getObject = function(path, name, callback) {
    var service = this.getService(path);
    return service.getObject(name, callback);
  };

  this.getInterface = function(path, objname, name, callback) {
    return this.getObject(path, objname, function(err, obj) {
      if (err) return callback(err);
      callback(null, obj.as(name));
    });
  };

  // TODO: refactor

  // bus meta functions
  this.addMatch = function(match, callback) {
    this.invokeDbus(
      { member: 'AddMatch', signature: 's', body: [match] },
      callback
    );
  };

  this.removeMatch = function(match, callback) {
    this.invokeDbus(
      { member: 'RemoveMatch', signature: 's', body: [match] },
      callback
    );
  };

  this.getId = function(callback) {
    this.invokeDbus({ member: 'GetId' }, callback);
  };

  this.requestName = function(name, flags, callback) {
    this.invokeDbus(
      { member: 'RequestName', signature: 'su', body: [name, flags] },
      function(err, name) {
        if (callback) callback(err, name);
      }
    );
  };

  this.releaseName = function(name, callback) {
    this.invokeDbus(
      { member: 'ReleaseName', signature: 's', body: [name] },
      callback
    );
  };

  this.listNames = function(callback) {
    this.invokeDbus({ member: 'ListNames' }, callback);
  };

  this.listActivatableNames = function(callback) {
    this.invokeDbus({ member: 'ListActivatableNames' }, callback);
  };

  this.updateActivationEnvironment = function(env, callback) {
    this.invokeDbus(
      {
        member: 'UpdateActivationEnvironment',
        signature: 'a{ss}',
        body: [env]
      },
      callback
    );
  };

  this.startServiceByName = function(name, flags, callback) {
    this.invokeDbus(
      { member: 'StartServiceByName', signature: 'su', body: [name, flags] },
      callback
    );
  };

  this.getConnectionUnixUser = function(name, callback) {
    this.invokeDbus(
      { member: 'GetConnectionUnixUser', signature: 's', body: [name] },
      callback
    );
  };

  this.getConnectionUnixProcessId = function(name, callback) {
    this.invokeDbus(
      { member: 'GetConnectionUnixProcessID', signature: 's', body: [name] },
      callback
    );
  };

  this.getNameOwner = function(name, callback) {
    this.invokeDbus(
      { member: 'GetNameOwner', signature: 's', body: [name] },
      callback
    );
  };

  this.nameHasOwner = function(name, callback) {
    this.invokeDbus(
      { member: 'NameHasOwner', signature: 's', body: [name] },
      callback
    );
  };
};
