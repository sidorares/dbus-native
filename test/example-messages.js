var fs = require('fs');
var assert = require('assert');
var unmarshall = require('../lib/message').unmarshall;
var marshall   = require('../lib/message').marshall;
var dir = __dirname + '/fixtures/messages/';

describe('given base-64 encoded files with complete messages', function() {
  it('should be able to read them all', function() {
    var messages = fs.readdirSync(dir);
    messages.forEach(function(name) {
      var msg = fs.readFileSync(dir + name, 'ascii');
      var msgBin = new Buffer(msg, 'base64');
      //var hexy = require('../lib/hexy').hexy;
      //console.log(hexy(msgBin));
      //console.log(unmarshall(msgBin));
      var unmarshalledMsg = unmarshall(msgBin);
      var marshalled = marshall(unmarshalledMsg);
      assert.deepEqual(unmarshalledMsg, unmarshall(marshalled));
    });
  });
});
