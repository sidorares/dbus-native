const utils             = require ('./utils')
const Errors            = require ('./Errors')
const inspect           = require ('util').inspect
const Promise           = require ('bluebird')
const constants         = require ('./constants')
const signature         = require ('./signature')
const DBusProxy         = require ('./DBusProxy')
const DBusService       = require ('./DBusService')
const EventEmitter      = require ('events').EventEmitter
const stdDbusIfaces     = require ('./stdifaces')
const parseSignature    = require ('./signature')
const DBusObjectLibs    = require ('./DBusObjectLibs')
const DBusInterfaceLibs = require ('./DBusInterfaceLibs')

const DBUS_MAX_NAME_LENGTH = utils.DBUS_MAX_NAME_LENGTH

const mandatory = utils.mandatory

const NotImplementedError = Errors.NotImplementedError
const ServiceUnknownError = Errors.ServiceUnknownError

const DBusObject = DBusObjectLibs.DBusObject

const DBusInterface = DBusInterfaceLibs.DBusInterface

// Whether to set this file's functions into debugging (verbose) mode
const DEBUG_THIS_FILE = false

// Allows for setting all files to debug in once statement instead of manually setting every flag
const DEBUG = DEBUG_THIS_FILE || utils.GLOBAL_DEBUG

/** @module Bus */

module.exports = function bus(conn, opts) {
    if (!(this instanceof bus)) {
        return new bus(conn);
    }
    if(!opts) opts = {};

    var self = this;
    this.connection = conn;
    this.serial = 1;
    this.cookies = {}; // TODO: rename to methodReturnHandlers
    this.proxyCookies = {} // will contain serials of msgs for which we must translate return types to new API
    this.methodCallHandlers = {};
    this.signals = new EventEmitter();
    this.exportedObjects = {};

    /**
     * Will store all DBusServices that are created and exposed on the bus.<br>
     * It is used to present introspection data.
     * @type {Map<DBusObject>}
    */
    this.exposedServices = new Map()

    // fast access to tree formed from object paths names
    // this.exportedObjectsTree = { root: null, children: {} };

    this.invoke = function(msg, callback) {
       if (!msg.type)
          msg.type = constants.messageType.methodCall;
          msg.serial = self.serial++

       self.cookies[msg.serial] = callback;
       if (msg.proxy === true) self.proxyCookies[msg.serial] = true
    //    console.log ('-- invoke --')
    //    console.log (inspect (msg, {colors: true, depth: 4}))
    //    console.log (`message callback:\n${inspect (self.connection.message.toString())}`)
    //    console.log ('-- /invoke --')
       self.connection.message(msg);
    };

    this.invokeDbus = function(msg, callback) {
       if (!msg.path)
           msg.path = '/org/freedesktop/DBus';
       if (!msg.destination)
           msg.destination = 'org.freedesktop.DBus';
       if (!msg['interface'])
           msg['interface'] = 'org.freedesktop.DBus';
       self.invoke(msg, callback);
    };

    this.mangle = function(path, iface, member) {
        var obj = {};
        if (typeof path === 'object') // handle one argumant case mangle(msg)
        {
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
            serial: self.serial,
            'interface': iface,
            path: path,
            member: name
        };
        if (signature) {
            signalMsg.signature = signature;
            signalMsg.body = args;
        }

        if (DEBUG) console.log (`Signal Message to be sent:\n${inspect (signalMsg, {depth: 5})}`)
        self.connection.message(signalMsg);
    }

    this.sendError = function(msg = mandatory(), errorName = mandatory(), errorText) {
        /*
            Check that the error name respects the naming syntax, which is the same as interfaces, see
            https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface
        */
        if (!utils.isValidErrorName (errorName)) {
            throw new TypeError ('Error\'s name missing or invalid (see http://bit.ly/2cFC6Vx for naming rules).')
        }

        var reply = {
            type: constants.messageType.error,
            replySerial: msg.serial,
            destination: msg.sender,
            errorName: errorName,
            signature: 's',
            body: [ errorText ]
        };
        //console.log('SEND ERROR', reply);
        this.connection.message(reply);
    }

    this.sendReply = function(msg, signature, body)
    {
       var reply = {
            type: constants.messageType.methodReturn,
            replySerial: msg.serial,
            destination: msg.sender,
            signature: signature,
            body: body
        };
       this.connection.message(reply)
    }

    // route reply/error
    this.connection.on('message', function(msg) {
       var msg = JSON.parse(JSON.stringify(msg));

       // Check if the service uses the new API, if yes, deal with it
       if (self.exposedServices.has (msg.destination)) {
           self.handleDBusMessage (msg)
           return // return to prevent the rest of the function to deal with it (old API)
       }

       var handler;
       if (msg.type == constants.messageType.methodReturn || msg.type == constants.messageType.error) {
           handler = self.cookies[msg.replySerial];
           if (msg.type == constants.messageType.methodReturn && msg.body)
              msg.body.unshift(null); // first argument - no errors, null
           if (handler) {
              delete self.cookies[msg.replySerial];
              var props = {
                 connection: self.connection,
                 bus: self,
                 message: msg,
                 signature: msg.signature
              };

              if (msg.type == constants.messageType.methodReturn) {
                //   console.log (`handler:\n${handler.toString()}`)
                  // If the method call was issued from a DBuxProxy, convert the return values to new API
                  if (self.proxyCookies[msg.replySerial]) {
                      let trees = parseSignature (msg.signature)
                      // msg.body[0] contains 'null' because of the callback syntax
                      let translatedTypes = msg.body.slice(1).map( (e, idx) => utils.fromOldToNewAPI (e, trees[idx]))

                      delete self.proxyCookies[msg.replySerial]

                      /*
                        We have to deal differently here if we have one or multiple return values.
                        If we have only one, then we must return an array whose first value is null (indicating no
                        error) and whose second value if the return value.
                        If we have severla values, we must return an array whose first value is null (idem) and whose
                        second value is an array containing the values.
                        This is due to the fact that the call is promisified, so the callback here is the promise.
                        If one value is returned, the user can call .then(), if there are several values, either he can
                        call .then() and get an array, or he can call .spread() and get each individual value
                        separately.
                      */
                      if (translatedTypes.length === 1)
                          handler.apply(props, [null, translatedTypes[0]])
                      else
                          handler.apply(props, [null, translatedTypes])
                  } else {
                      handler.apply(props, msg.body); // body as array of arguments
                  }
              }
              else
                 handler.call(props, msg.body);  // body as first argument
           }
       } else if (msg.type == constants.messageType.signal) {
           if (DEBUG)
               console.log ('Received Signal to re-emit (under ' + self.mangle (msg) + '):\n' + inspect (msg, {depth: 6}))

           self.signals.emit(self.mangle(msg), msg.body, msg.signature);
       } else { // methodCall
           if (DEBUG) console.log ('Message call received:\n', inspect (msg))
           if (stdDbusIfaces(msg, self))
               return;

           // exported interfaces handlers
           var obj, iface, impl;
           if (obj = self.exportedObjects[msg.path]) {

               if (iface = obj[msg['interface']]) {
                   // now we are ready to serve msg.member
                   impl = iface[1];
                   var func = impl[msg.member];
                   if (!func) {
                       // TODO: respond with standard dbus error
                       console.error('Method ' + msg.member + ' is not implemented ');
                       throw new Error('Method ' + msg.member + ' is not implemented ');
                   };
                   try {
                       result = func.apply(impl, msg.body);
                   } catch (e) {
                       console.error("Caught exception while trying to execute handler: ", e);
                       throw e;
                   }
                   // TODO safety check here
                   var resultSignature = iface[0].methods[msg.member][1];
                   var reply = {
                       type: constants.messageType.methodReturn,
                       destination: msg.sender,
                       replySerial: msg.serial
                   };
                   if (result) {
                       reply.signature = resultSignature;
                       reply.body = [result];
                   }
                   self.connection.message(reply);
                   return;
               } else {
                   console.error('Interface ' + msg['interface'] + ' is not supported');
                   // TODO: respond with standard dbus error
               }
           }
           // setMethodCall handlers
           handler = self.methodCallHandlers[self.mangle(msg)];
           if (handler) {
           var result;
           try {
               result = handler[0].apply(null, msg.body);
           } catch (e) {
               console.error("Caught exception while trying to execute handler: ", e);
               self.sendError(e.message, e.description);
               return;
           }
           var reply = {
               type: constants.messageType.methodReturn,
               destination: msg.sender,
               replySerial: msg.serial
               //, sender: self.name
           };
           if (result) {
               reply.signature = handler[1];
               reply.body = result;
           }
           self.connection.message(reply);
           } else {
               self.sendError(msg, 'org.freedesktop.DBus.Error.UnknownService', 'Uh oh oh(1)');
           }

       }
    });

    /**
     * Handle DBus message (new API)<br>
     * Takes care of dealing with method calls, method returns, signals call, properties, etc.
     */
    this.handleDBusMessage = function (msg = mandatory()) {
        if (DEBUG) console.log ('DBus Message:\n' + inspect (msg, {colors: true, depth: 6}))
        // Deal with messages from standard interfaces
        if (stdDbusIfaces(msg, self)) {
            if (DEBUG) console.log ('>>> Standard interface dealt with.')
            return
        }

        // If this was not a message from a standard interface, let's fetch the correct service, object and interface
        let service
        let pathComponents = msg.path.split ('/')
        let abord = false // controls if we should stop traversing the objects
        let currObj // will be used to traverse the service and the objects
        let iface

        // First, we fetch the corresponding DBusService (and assign it to currObj to initiate traversing)
        service = currObj = self.exposedServices.get (msg.destination)

        // Sanity check that 'service' is not undefined
        if (typeof service === 'undefined')
            throw new Error ('internal error: service was not on exposed services Map.')

        // Then try to traverse the DBusService to reach the destination object
        pathComponents.shift() // get rid of the empty '' caused by the initial '/'
        pathComponents.unshift ('/') // add the '/' back, because there is always a root '/' object

        while (!abord && pathComponents.length > 0) {
            let currPathComponent = pathComponents.shift()

            // Abord if the current object doesn't have an object at the specified path component
            if (! (currObj[currPathComponent] instanceof DBusObject)) {
                // Reply with a proper DBus error
                let str = `No such interface '${msg.interface}' on object at path '${msg.path}'`

                self.sendError (msg, 'org.freedesktop.DBus.Error.UnknownMethod', str)
                return
            }

            // Traverse the object
            currObj = currObj[currPathComponent]
        }

        // At this point we have traversed the object, let's check if the target object has the requested interface
        if (! (currObj[msg.interface] instanceof DBusInterface)) {
            // Reply with a proper DBus error
            let str = `No such interface '${msg.interface}' on object at path '${msg.path}'`

            self.sendError (msg, 'org.freedesktop.DBus.Error.UnknownMethod', str)
            return
        }

        /*
        At this point, we have confirmed that the requested object path exists and it has the correct
        interface.
        Now we look at the type of message we are dealing with and proceed accordingly.
        */
        iface = currObj[msg.interface]

        // Deal with 'methodCall' messages
        if (msg.type == constants.messageType.methodCall) {
            let methodName = msg.member
            let methodCall

            /*
                Check if the interface possesses the function in its interface description
                and if there is a function with the correct name
            */
            if (!iface._ifaceDesc.methods.has (methodName) || typeof iface[methodName] !== 'function') {
                // Reply with a proper DBus error
                let str = `No such method '${methodName}'`

                self.sendError (msg, 'org.freedesktop.DBus.Error.UnknownMethod', str)
                return
            }

            // TODO: Do we need to check for params matching?

            /*
                Now we call the function.
                It's called with Promise.try which gives freedom to the user of the library:
                - for synchronous calls, the user can either return a normal value and Promise.try will turn it into a
                  fullfilled promise, which will be used in the .then() or return an already-fullfilled promise which
                  will be used in the .then() too.
                  In case of error, the user can throw Errors and they will be caught in the .catch()
                - for asynchronous calls, the user must return a promise
            */
            if (msg.body === undefined)
                // If there are not arguments, explicitly call the function without any argument
                methodCall = Promise.try (() => iface[methodName] ())
            else {
                /*
                    If there are arguments, it's a little tricky: we need to convert the old API-formatted types
                    in the new API-type format (so it's more convenient and intuitive to the user).
                    This is why we need to call `utils.fromOldToNewAPI()` before passing the arguments
                */
                if (DEBUG) {
                    console.log ('msg.signature: ' + msg.signature)
                    console.log ('msg.body (must be translated to new API):\n' + inspect (msg.body, {depth: 5}))
                }

                // Build the signature tree to assist in parsing
                let tree = signature (msg.signature)

                if (DEBUG) console.log ('Signature tree: ' + inspect (tree, {depth: 6}))

                // Convert each type from the old to the new API
                let t = msg.body.map ((e, idx) => utils.fromOldToNewAPI (e, tree[idx]))

                if (DEBUG) console.log (`\nTranslated types:\n${inspect (t, {depth: 5})}\n`)

                // Finally call the target method with the arguments in order
                methodCall = Promise.try (() => iface[methodName] (...t))
            }

            methodCall
            .then( ret => {
                // If the call succeeded, we must translate it into the OLD API's structure so that marshalling is OK
                if (DEBUG) console.log ('ret: ' + inspect (ret, {colors: true, depth: 5}))

                let reply = {
                    type: constants.messageType.methodReturn,
                    destination: msg.sender,
                    replySerial: msg.serial
                }

                // If we have some return value from the function, build the 'reply.signature' and 'reply.body' field
                if (ret !== undefined) {
                    // Get the output
                    let output = iface._ifaceDesc.methods.get(methodName).output
                    let trees
                    let translatedTypes

                    // Convert the output into an array if it's not already
                    if (!Array.isArray (output))
                        output = [output]

                    // If we have only one return value, convert it and return it
                    if (output.length === 1) {
                        output = output[0]
                        /*
                            - Signature annotation elements should have only one key (the name of the argument), this
                              is why we take output[Object.keys(output)[0]] TODO: check if indeed there is only one key
                              and fail otherwise with 'Bad Formatted'
                        */
                        trees = signature (output[Object.keys(output)[0]])[0]
                        translatedTypes = utils.fromNewToOldAPI (ret, trees)
                        reply.signature = output[Object.keys(output)[0]]
                        reply.body = [translatedTypes]
                    }
                    // If we have several values, convert them all and return them
                    else {
                        /*
                            - Signature annotation elements should have only one key (the name of the argument), this
                              is why we take obj[Object.keys(obj)[0]] TODO: check if indeed there is only one key
                              and fail otherwise with 'Bad Formatted'
                            - Signature parsing function 'signature()' returns an array ; since we parsed only one,
                              we have to take the first element, this is why we have '[0]' after the call to signature()
                        */
                        trees = output.map (obj => signature (obj[Object.keys(obj)[0]])[0])
                        translatedTypes = ret.map ((val, idx) => utils.fromNewToOldAPI (val, trees[idx]))
                        reply.signature = output.reduce ((acc, obj) => acc + '' + obj[Object.keys(obj)[0]], '')
                        reply.body = translatedTypes
                    }

                    self.connection.message (reply)
                    return

                } else {
                    // If there is not return from the function, just reply without a body
                    self.connection.message (reply)
                }
            })
            .catch( (err) => {
                console.error ('Got error: ' + err)
                // If the call raised an error, send a proper DBus error
                self.sendError (msg, 'org.freedesktop.DBus.Error.' + err.name, err.message)
            })

            return
        }
    }

    this.setMethodCallHandler = function(objectPath, iface, member, handler) {
        var key = self.mangle(objectPath, iface, member);
        self.methodCallHandlers[key] = handler;
    };

    this.exportInterface = function(obj = mandatory(), path = mandatory(), iface = mandatory()) {
        var entry;

        /*
            Check that the interface to expose does have a name (otherwise it makes 'undefined' interfaces)
            and that the name respects DBus specs:
            https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface
        */
        if (!utils.isValidIfaceName (iface.name)) {
            throw new TypeError ('Interface\'s name missing or invalid (see http://bit.ly/2cFC6Vx for naming rules).')
        }

        if (!self.exportedObjects[path])
            entry = self.exportedObjects[path] = {};
        else
            entry = self.exportedObjects[path];
        entry[iface.name] = [iface, obj];
        // monkey-patch obj.emit()
        if (typeof obj.emit === 'function' ) {
            var oldEmit = obj.emit;
            obj.emit = function() {
                var args = Array.prototype.slice.apply(arguments);
                var signalName = args[0];
                if (!signalName)
                    throw new Error('Trying to emit undefined signa');

                //send signal to bus
                var signal;
                if (iface.signals && iface.signals[signalName])
                {
                    signal = iface.signals[signalName];
                    //console.log(iface.signals, iface.signals[signalName]);
                    var signalMsg = {
                        type: constants.messageType.signal,
                        serial: self.serial,
                        'interface': iface.name,
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
    if(opts.direct !== true) {
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
            var obj = new DBusObject(name, this);
            //console.log(obj);
            var introspect = require('./introspect.js');
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

    /**
     * Returns the remote DBus service which is registered by this name
     * @param {string} serviceName Name of the remote DBus service for which we want to build a proxy
     * @param {number} [maxIntrospectionDepth=Infinity] Maximum depth at which we will carry the introspection
     */
    this.getService2 = function (serviceName = mandatory(), maxIntrospectionDepth = Infinity) {
        // We can't use 'promisify' here, because it complains that 'this.invokeDBus' is not a function
        return new Promise ((resolve, reject) => {
            self.listNames ((err, names) => {
                if (err) reject (err)
                else {
                    // Check if the service name we requested exists
                    // if (names.findIndex ( (name) => name === serviceName) !== -1) <- why bother?
                    if (names.includes (serviceName))
                        // If the service exists, create a DBusService to represent it and return it
                        resolve (new DBusProxy (serviceName, self))
                    else {
                        /*
                            We tried to request a service that is not available on the bus, for the moment, we simply
                            return an error.
                            TODO: first check if the service is activatable, if yes, active it and return the service,
                            otherwise return the error.
                        */
                        reject (new ServiceUnknownError (serviceName))
                    }
                }
            })
        })
    }

    /**
     * Expose a DBusService to the bus, making its DBus methods, properties and signals available to other DBus clients.
     * @param {DBusService} service The {@link DBusService} object that we will expose on the bus
     * @param {string} serviceName   The name under which we want to expose our service
     * @param {number} [flag=6]      Flags that controls if we want to steal the name, if we let others steal, it, etc. Look at the DBus documentation for more information.
     */
     this.exposeService = function (service = mandatory(), serviceName = mandatory(), flag = utils.DBUS_NAME_FLAG_REPLACE_EXISTING | utils.DBUS_NAME_FLAG_DO_NOT_QUEUE) {
        // Try to request the name, and if it succeeds, set service's name and bus
        return Promise.promisify (this.requestName) (serviceName, flag)
        .then( (retCode) => {
            // We return a success only if we are now the sole, primary owner of the name...
            if (retCode === utils.DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER) {
                let currObj = service['/']
                service.name = serviceName
                service.bus = self

                /*
                    Add this service to the list of exposed services
                    NOTE: we don't need to check if 'exposedServices' already has it because if it had, the return code
                    would be DBUS_REQUEST_NAME_REPLY_ALREADY_OWNER
                */
                this.exposedServices.set (serviceName, service)

                /*
                    - Traverse all the hierarchy of objects
                        - Find the signals
                        - listen to them
                        - convert them into DBus signal and emit them on the bus (when they ar eemitted)
                        - save a reference to the DBus service to all interfaces
                */
                function finalizeExport(obj, path = '') {
                    let objKeys = Object.keys(obj)
                    let childrenPath = objKeys.filter (key => utils.isValidPathComponent (key))
                    let ifacesNames = objKeys.filter (key => utils.isValidIfaceName (key))


                    // For all interfaces of this object...
                    for (let ifaceName of ifacesNames) {
                        if (DEBUG) console.log ('\tiface: ' + inspect (ifaceName, {depth: 6}))

                        // console.log (inspect (obj[ifaceName]._ifaceDesc, {depth: 7}))
                        let signalsDef = obj[ifaceName]._ifaceDesc.signals

                        /*
                            ...first, save a refence of the DBusService in the interface
                            We use double underscore, because in DBusInterface, when one defines a property 'foo',
                            the property 'foo' is made a method (getter / setter) and the actual proeprty value
                            is stored in '_foo', so in case someone defines a property named 'service', it would
                            override '_service'.
                            This way, __service is safe, unless someone tries to define a property named '_service', but
                            this should be refused.
                        */
                        obj[ifaceName].__service = service

                        //... then find all signals, listen to them and re-emit them in DBus form when they happen
                        for (let [signalName, signalType] of signalsDef) {
                            if (DEBUG) {
                                console.log ('\t\tsignal: ' + signalName)
                                console.log ('\t\tpath: ' + path)
                                console.log ('\t\tiface: ' + obj[ifaceName].name)
                                console.log ('\t\tsignature: ' + inspect(signalType, {depth: 5}))
                            }

                            obj[ifaceName].on (signalName, (...args) => {
                                let output = Array.isArray (signalType.output) ? signalType.output : [signalType.output]
                                // Parse the signal's signature and convert it back to DBus-syntax
                                let signature = output.reduce( (acc, v) => acc + '' + v[Object.keys (v)[0]], '')
                                let trees
                                let translatedTypes

                                // Build signature trees from annotation
                                trees = output.map (obj => parseSignature (obj[Object.keys(obj)[0]])[0])
                                // Translate signal return values from new API to marshalling API
                                translatedTypes = args.map( (v, idx) => utils.fromNewToOldAPI (v, trees[idx]))

                                // Re-emit the signal on the DBus bus
                                self.sendSignal (path,
                                                 obj[ifaceName]._ifaceName,
                                                 signalName,
                                                 signature,
                                                 translatedTypes
                                                )
                            })
                        }
                    }

                    // Then, recursively find and relay signals to this object's children
                    for (let childPath of childrenPath) {
                        if (DEBUG) console.log ('Deal with object ' + childPath)
                        finalizeExport (obj[childPath], path + '/' + childPath)
                    }
                }
                if (DEBUG) console.log ('Deal with object /')
                finalizeExport (currObj)

                return
            }
            /*
                ...otherwise we reject the promise with the return code so that the user can decide what to do
            */
            else {
                if (DEBUG)
                    console.warn ('Return code \'' + retCode + '\' returned when requesting name.')
                return Promise.reject (retCode)
            }
        })
        .catch( (err) => {
            console.error ('Failed to expose service on bus: ' + err)
        })
    }

    // TODO: refactor

    // bus meta functions
    this.addMatch = function(match, callback) {
        if(!self.name) return callback(null, null);
        // this.invokeDbus({ 'member': 'AddMatch', signature: 's', body: [match] }, callback);
        self.invokeDbus({ 'member': 'AddMatch', signature: 's', body: [match] }, callback);
    };

    this.removeMatch = function(match, callback) {
        if(!self.name) return callback(null, null);
        this.invokeDbus({ 'member': 'RemoveMatch', signature: 's', body: [match] }, callback);
    };

    this.getId = function(callback) {
        this.invokeDbus({ 'member': 'GetId' }, callback);
    };

    this.requestName = function(name, flags, callback) {
        self.invokeDbus({ 'member': 'RequestName', signature: 'su', body: [name, flags] }, function(err, name) {
            //self.name = name;
            if (callback)
                callback(err, name);
        });
    };

    this.releaseName = function(name, callback) {
        this.invokeDbus({ 'member': 'ReleaseName', signature: 's', body: [name] }, callback);
    };

    this.listNames = function(callback) {
       this.invokeDbus({ 'member': 'ListNames' }, callback);
    };

    this.listActivatableNames = function(callback) {
       this.invokeDbus({ 'member': 'ListActivatableNames', signature: 's', body: [name]}, callback);
    };

    this.updateActivationEnvironment = function(env, callback) {
       this.invokeDbus({ 'member': 'UpdateActivationEnvironment', signature: 'a{ss}', body: [env]}, callback);
    };

    this.startServiceByName = function(name, flags, callback) {
       this.invokeDbus({ 'member': 'StartServiceByName', signature: 'su', body: [name, flags] }, callback);
    };

    this.getConnectionUnixUser = function(name, callback) {
       this.invokeDbus({ 'member': 'GetConnectionUnixUser', signature: 's', body: [name]}, callback);
    };

    this.getConnectionUnixProcessId = function(name, callback) {
       this.invokeDbus({ 'member': 'GetConnectionUnixProcessID', signature: 's', body: [name]}, callback);
    };

    this.getNameOwner = function(name, callback) {
       this.invokeDbus({ 'member': 'GetNameOwner', signature: 's', body: [name]}, callback);
    };

    this.nameHasOwner = function(name, callback) {
       this.invokeDbus({ 'member': 'NameHasOwner', signature: 's', body: [name]}, callback);
    };
};
