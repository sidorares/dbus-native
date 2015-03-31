var xml2js = require('xml2js');
module.exports = function(obj, callback) {
    var bus = obj.service.bus;
    bus.invoke({
      destination:  obj.service.name,
      path:         obj.name,
      'interface': 'org.freedesktop.DBus.Introspectable',
      member:       'Introspect'
    }, function(err, xml) {
      if (err) return callback(err);
      var parser = new xml2js.Parser({explicitArray: true});
      parser.parseString(xml, function (err, result) {
          if (err) return callback(err);
          if (!result.interface) return callback(new Error('No such interface found'));
          var proxy = {};
          var i, m, s, ifaceName, method, property, signal, iface, a, arg, signature, currentIface;
          var ifaces = result['interface'];
          for (i=0; i < ifaces.length; ++i) {
              iface = ifaces[i];
              ifaceName = iface['@'].name;
              currentIface = proxy[ifaceName] = {};

              (function() {
                  var callbacks = [];
                  var sigHandlers = [];
                  function getSigHandler(callback) {
                      var index;
                      if ((index = callbacks.indexOf(callback)) == -1) {
                          index = callbacks.push(callback) - 1;
                          sigHandlers[index] = function(messageBody) {
                               callback.apply(null, messageBody)
                          }
                      }
                      return sigHandlers[index];
                  }

                  function getMatchRule(objName, ifName, signame) {
                      return "type='signal',path='" + objName + "',interface='" + ifName + "',member='" + signame + "'";
                  }

                  currentIface.addListener = currentIface.on = (function(ifName) {
                      return function(signame, callback) {
                          // http://dbus.freedesktop.org/doc/api/html/group__DBusBus.html#ga4eb6401ba014da3dbe3dc4e2a8e5b3ef
                          // An example is "type='signal',sender='org.freedesktop.DBus', interface='org.freedesktop.DBus',member='Foo', path='/bar/foo',destination=':452345.34'" ...
                          //var match = "type='signal',sender='"+obj.service.name+ ...

                          var signalFullName = bus.mangle(obj.name, ifName, signame);

                          if (!bus.signals.listeners(signalFullName).length) {
                              // This is the first time, so call addMatch
                              var match = getMatchRule(obj.name, ifName, signame);
                              bus.addMatch(match, function(err, result) {
                                  if (err) throw new Error(err);

                                  bus.signals.on(signalFullName, getSigHandler(callback));
                              });
                          }
                          else {
                              // The match is already there, just add event listener
                              bus.signals.on(signalFullName, getSigHandler(callback));
                          }
                      }
                  })(ifaceName);

                  currentIface.removeListener = (function(ifName) {
                      return function(signame, callback) {
                          var signalFullName = bus.mangle(obj.name, ifName, signame);
                          bus.signals.removeListener(signalFullName, getSigHandler(callback));

                          if (!bus.signals.listeners(signalFullName).length) {
                              // There is no event handlers for this match
                              var match = getMatchRule(obj.name, ifName, signame);
                              bus.removeMatch(match, function(err, result) {
                                  if (err) throw new Error(err);

                                  // Now it is safe to empty these arrays
                                  callbacks.length = 0;
                                  sigHandlers.length = 0;
                              });
                          };
                      };
                  })(ifaceName);
              })();

              for (m=0; iface.method && m < iface.method.length; ++m)
              {
                  method = iface.method[m];
                  signature = '';
                  name = method['@'].name;
                  for (a=0; method.arg && a < method.arg.length; ++a) {
                      arg = method.arg[a]['@'];
                      //console.log(arg);
                      if (arg.direction === 'in')
                          signature += arg.type;
                  }

    			 // add method
				  currentIface[name] = (function(ifName, methodName, signature) {
					  return function() {
						  var args = Array.prototype.slice.apply(arguments);
    					  var callback = (typeof(args[args.length - 1]) == "function") ? args.pop() : function() {};
						  var msg = {
							  destination: obj.service.name,
							  path: obj.name,
							  'interface': ifName,
							  member: methodName
						  };
						  if (signature !== '') {
							  msg.signature = signature;
							  msg.body = args;
						  }
						  bus.invoke(msg, callback);
					 };
				  })(ifaceName, name, signature);

                  //console.log('    method: ', name, signature);
              }
              for (var p=0; iface.property && p < iface.property.length; ++p)
              {
                  property = iface.property[p];
                  name = property['@'].name;
                  //console.log('    property: ', property);
                  // get = function(err, result) {}
                  //TODO: move up
                  function addReadProp(iface, ifName, propName, property) {
                      Object.defineProperty(iface, propName, {
                         get: function() {
                             return function(callback) {
                                 bus.invoke({
                                     destination: obj.service.name,
                                     path: obj.name,
                                     'interface': 'org.freedesktop.DBus.Properties',
                                     member: 'Get',
                                     signature: 'ss',
                                     body: [ifName, propName]
                                 }, function(err, val) {
                                     if (err) callback(err);
                                     var signature = val[0];
                                     if (signature.length === 1)
                                         callback(err, val[1][0]);
                                     else
                                         callback(err, val[1]);
                                 });
                             };
                         },
                         set: function(val) {
                             bus.invoke({
                                 destination: obj.service.name,
                                 path: obj.name,
                                 'interface': 'org.freedesktop.DBus.Properties',
                                 member: 'Set',
                                 signature: 'ssv',
                                 body: [ifName, propName, [property['@'].type, val]]
                             });
                         }
                      });
                  }
                  addReadProp(currentIface, ifaceName, name, property);
              }
              for (s=0; iface.signal && s < iface.signal.length; ++s)
              {
                  signal = iface.signal[s];
                  var name = signal['@'].name;
                  //console.log('============    signal: ', name);
              }
          }
          callback(null, proxy);
      });
    });
}
