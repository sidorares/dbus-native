var marshall = require('../lib/marshall');
var unmarshall = require('../lib/unmarshall');
var message = require('../lib/message');
var binary = require('binary');
var buffers = require('buffers');
var assert = require('assert');
var hexy = require('../lib/hexy').hexy;
var common = require('./common');

function msg2buff(msg) {
    var buff = buffers();
    var dbus = {
        write: function(data) {
            buff.push(data);
        },
        get: function() {
            return buff.toBuffer();
        }
    };
    message.write.call(dbus, msg);
    return dbus.get();
}

function buff2msg(buff, callback) {
   var dbus = {
       emit: function(name, data) {
           if (name === 'message')
               callback(data);
       }
   };
   var bs = binary(buff);
   message.read.call(bs, dbus, {});
}

var msg1 = {
    type: 1,
    destination: "final",
    flags: 1,
    signature: "uuu",
    body: [10, 20, 400]
};

function test(msg) {
    var messageBuff = msg2buff(msg);
    buff2msg(messageBuff, function(msgout) {
    assert.deepEqual(msg, msgout);
    });
}

test(msg1);
//test({signature: 'ai', body: [[]]});
