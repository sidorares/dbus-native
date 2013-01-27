#!/usr/bin/env node

var xml2js = require('xml2js');
var dbus = require('../index.js');
var argv = require('optimist')
    .boolean(['server', 'dump'])
    .argv;

function die(err) {
    console.log(err);
    process.exit(-1);
}

var bus;
if (argv.bus == 'system')
    bus = dbus.systemBus();
else
    bus = dbus.sessionBus();


function getXML(callback) {
    if (argv.xml) {
       var fs = require('fs');
       fs.readFile(argv.xml, 'ascii', callback);
    } else {
        bus.invoke({
          destination:  argv.service,
          path:         argv.path,
          'interface': 'org.freedesktop.DBus.Introspectable',
          member:       'Introspect'
        }, callback);
    }
}

if (argv.dump)
{
    getXML(function(err, xml) {
        console.log(xml);
        bus.connection.end();
    });
}

if (!argv.server) {
    getXML(function(err, xml) {

      if (err)
          die(err);
  
      var output = [];

      var parser = new xml2js.Parser({explicitArray: true});
      parser.parseString(xml, function (err, result) {
          if (err) die(err);

          var proxy = {};
          var i, m, s, ifaceName, method, property, signal, iface, a, arg, signature, currentIface;
          var ifaces = result['interface'];
          for (i=0; i < ifaces.length; ++i) {
              iface = ifaces[i];
              ifaceName = iface['@'].name;

              output.push('module.exports[\'' + ifaceName + '\'] = function(bus) {');
              output.push('    this.addListener = this.on = function(signame, callback) {');
                                   //TODO: add path and interface to path
              output.push('        bus.addMatch(\'type=\\\'signal\\\',member=\\\'\' + signame + \'\\\'\', function(err, result) {');
              output.push('            if (err) throw new Error(err);');
              output.push('        });');
              output.push('        var signalFullName = bus.mangle(\'' + argv.path + '\', \'' + ifaceName + '\', signame);');
              output.push('        bus.signals.on(signalFullName, function(messageBody) {');
              output.push('             callback.apply(null, messageBody);');
              output.push('        });');
              output.push('    };');
                
              for (m=0; iface.method && m < iface.method.length; ++m)
              {
                  method = iface.method[m];
                  signature = '';
                  name = method['@'].name;
                  
                  var decl = '    this.' + name + ' = function('
                  var params = [];
                  for (a=0; method.arg && a < method.arg.length; ++a) {
                      arg = method.arg[a]['@'];
                      if (arg.direction === 'in') {
                          decl += arg.name + ', ';
                          params.push(arg.name)
                          signature += arg.type;
                      }
                  }
                  decl += 'callback) {';
                  output.push(decl);
                  output.push('        bus.invoke({');
                  output.push('            destination: \'' + argv.service + '\',');
                  output.push('            path: \'' + argv.path + '\',');
                  output.push('            interface: \'' + ifaceName + '\',');
                  output.push('            member: \'' + name + '\',');
                  if (params != '') {
                      output.push('            body: [' + params.join(', ') + '], ');
                      output.push('            signature: \'' + signature + '\',');
                  };
                  output.push('        }, callback);');
                  output.push('    };');
              }
              for (p=0; iface.property && p < iface.property.length; ++p)
              {
                  property = iface.property[p];
                  name = property['@'].name;
                  console.log('    property: \n', property);
                  /*
                  // get = function(err, result) {}
                  //TODO: move up
                  function addReadProp(iface, propName, property) {
                      Object.defineProperty(iface, propName, {
                         get: function() {
                             return function(callback) {
                                 bus.invoke({
                                     destination: obj.service.name,
                                     path: obj.name,
                                     'interface': 'org.freedesktop.DBus.Properties',
                                     member: 'Get',
                                     signature: 'ss',
                                     body: [ifaceName, propName]
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
                             console.log('TODO: implement set property. Value passed:' 
                                     + val + ', property: ' + JSON.stringify(property, null, 4));
                         }
                      }); 
                  }
                  addReadProp(currentIface, name, property);
                  */
              }
              /*
              for (s=0; iface.signal && s < iface.signal.length; ++s)
              {
                  signal = iface.signal[s];
                  name = signal['@'].name;
                  console.log('============    signal: ', name, signal);
              }
              */
              output.push('}');
          }
          console.log(output.join('\n'));
          bus.connection.end();
      });
    });
}
