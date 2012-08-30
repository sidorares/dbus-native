var binary = require('binary');
var    put = require('put');
var crypto = require('crypto');
var     fs = require('fs');
var byline = require('byline');

function sha1(input)
{
   var shasum = crypto.createHash('sha1');
   shasum.update(input);
   return shasum.digest('hex');
}

function getUserHome() {
  return process.env[(process.platform.match(/$win/)) ? 'USERPROFILE' : 'HOME'];
}

function getCookie(context, id, cb) {

   var dirname = getUserHome() + '/.dbus-keyrings';
   var filename = dirname + '/' + context;
   // check it's not writable by others and readable by user
   fs.stat(dirname, function(err, stat) {
       if (err) 
           cb(err);
       //if (stat.mode & 066)
       if (stat.mode & 022)
           return cb(new Error('User keyrings directory is writeable by other users. Aborting authentication'));
       if (stat.uid != process.getuid())
           return cb(new Error('Keyrings directory is not owned by the current user. Aborting authentication!'));
       // TODO: some strange problems reading lines with binary && scan('\r\n'). Using byline until resolved
       var stream = byline(fs.createReadStream(filename));
       var found = false;
       stream.on('data', function(line) {
          var data = line.split(' ');
          if (id == data[0])
          {
             found = true;
             stream.end();
             return cb(null, data[2]);
          }
       });
       stream.on('end', function() {
          if (!found)
            return cb(new Error('cookie not found'));
       });
   });
}

function hexlify(input) {
    return Buffer(input.toString(), 'ascii').toString('hex');
    //return input.toString().split('').map(function(n) { return n.charCodeAt(0).toString(16) } ).join('');
}

var exports = module.exports = function auth(dbus, opts) {
    // filter used to make a copy so we don't accidently change opts data
    var authMethods;
    if (opts.authMethods) {
        // TODO: _.clone. Not-so-deep copy here is enough
        authMethods = opts.authMethods.filter(function() { return true;});
    } else {
        authMethods = ['EXTERNAL', 'DBUS_COOKIE_SHA1', 'ANONYMOUS'];
    }
    tryAuth.call(this, authMethods, dbus, opts);
};

function tryAuth(methods, dbus, opts) {
    var authMethod = methods.shift();    
    
    var id = hexlify(process.getuid());
    var binarystream = this;

    function beginOrNextAuth() {
        binarystream
          .scan('reply', Buffer('\r\n'))
          .tap(function(vars) {
              var ok = vars.reply.toString('ascii').match(/^([A-Za-z]+) (.*)/);
              if (ok && ok[1] === 'OK') {
                  put().put(Buffer('BEGIN\r\n')).write(dbus.stream);
                  dbus.state = 'connected';
                  dbus.emit('connect', ok[2]); // ok[2] = guid. Do we need it? 
              } else {
                 // TODO: parse error!
                 if (!methods.empty)
                     tryAuth(methods, dbus, opts);
                 else
                     dbus.emit('error', vars.reply);
              }
          });
    }

    switch(authMethod) {
    case 'EXTERNAL':
        put().put(Buffer('\0AUTH ' + authMethod + ' ' + id + '\r\n')).write(dbus.stream);
        beginOrNextAuth();
        break;
    case 'DBUS_COOKIE_SHA1':
        put().put(Buffer('\0AUTH ' + authMethod + ' ' + id + '\r\n')).write(dbus.stream);
        binarystream
          .scan('reply', Buffer('\r\n'))
          .tap(function(vars) {
              var data = Buffer(vars.reply.toString().split(' ')[1], 'hex').toString('binary').split(' ');
              var cookieContext = data[0];
              var cookieId = data[1];
              var serverChallenge = data[2];
              // any random 16 bytes should work, sha1(rnd) to make it simplier
              var clientChallenge = sha1(Date.now().toString() + (Math.random()*100).toString()); 
              getCookie(cookieContext, cookieId, function(err, cookie) {
                  if (err) throw err;
                  var response = sha1([serverChallenge, clientChallenge, cookie].join(':'));
                  var reply = hexlify(clientChallenge + response);
                  dbus.write('DATA ' + reply + '\r\n');
                  beginOrNextAuth();
              });
          });
        break;
    case 'ANONYMOUS':
        put().put(Buffer('\0AUTH ANONYMOUS \r\n')).write(dbus.stream);
        beginOrNextAuth();
        break;
    }
}
