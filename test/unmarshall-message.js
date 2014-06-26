var message = require('../lib/message');
var binary = require('binary');
var buffers = require('buffers');
var assert = require('assert');
var tests = require('./testdata.js');

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

describe('message marshall/unmarshall', function() {
    for(var testName in tests) {
        tests[testName].forEach(function(testData, testNum) {
            var testDesc = testName + ' ' + testNum + ' ' + testData[0] + '<-' + JSON.stringify(testData[1]);

            if (testData[2] === false) {
                return it(testDesc);
            }

            it(testDesc, function(done) {
                var msg = {
                    type: 1,
                    destination: "final",
                    flags: 1,
                    signature: testData[0],
                    body: testData[1]
                };

                buff2msg(msg2buff(msg), function(msgout) {
                    if (testData.length >= 4) {
                        // support for overriding the expect unmarshalled message
                        msg.body = testData[3];
                    }

                    assert.deepEqual(msgout, msg);
                    done();
                });
            });
        });
    }
});
