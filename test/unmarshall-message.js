var marshall = require('../lib/marshall');
var unmarshall = require('../lib/unmarshall');
var message = require('../lib/message');
var assert = require('assert');
var hexy = require('../lib/hexy').hexy;

if( assert.deepStrictEqual === undefined )  // workaround for node 0.12
    assert.deepStrictEqual = assert.deepEqual;

function msg2buff(msg) {
  return message.marshall(msg);
}

function buff2msg(buff) {
  return message.unmarshall(buff);
}

describe('message marshall/unmarshall', function() {
   var tests = require('./testdata.js');
   var testName, testData, testNum;
   for(testName in tests) {
    for (testNum = 0; testNum < tests[testName].length; ++testNum) {
       testData = tests[testName][testNum];
       var testDesc = testName + ' ' + testNum + ' ' + testData[0] + '<-' + JSON.stringify(testData[1]);
       if (testData[2] !== false) {
        (function(testData) {
          it(testDesc, function() {
            var msg = {
              type: 1,
              destination: "final",
              flags: 1,
              signature: testData[0],
              body: testData[1]
            };
            assert.deepStrictEqual(msg, buff2msg(msg2buff(msg)));
          });
        })(testData);
       }
    }
  }
});
