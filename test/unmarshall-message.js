const message = require('../lib/message');
const assert = require('assert');

function msg2buff(msg) {
  return message.marshall(msg);
}

function buff2msg(buff) {
  return message.unmarshall(buff);
}

describe('message marshall/unmarshall', () => {
  const tests = require('./testdata.js');
  let testName, testData, testNum;
  for (testName in tests) {
    for (testNum = 0; testNum < tests[testName].length; ++testNum) {
      testData = tests[testName][testNum];
      const testDesc = `${testName} ${testNum} ${testData[0]}<-${JSON.stringify(
        testData[1]
      )}`;
      if (testData[2] !== false) {
        (function (testData) {
          it(testDesc, () => {
            const msg = {
              type: 1,
              serial: 1,
              destination: 'final',
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
