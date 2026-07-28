const marshall = require('../lib/marshall');
const unmarshall = require('../lib/unmarshall');
const assert = require('assert');

function test(signature, data) {
  const marshalledBuffer = marshall(signature, data);
  const result = unmarshall(marshalledBuffer, signature);
  try {
    assert.deepStrictEqual(data, result);
  } catch (e) {
    console.log('signature   :', signature);
    console.log('orig        :', data);
    console.log('unmarshalled:', result);
    throw new Error("results don't match", { cause: e });
  }
}

describe('when signature is a{sX} and hashAsObject is used', () => {
  xit('serialises to expected value', () => {
    test('a{sv}', {
      test1: { subobj: { a1: 10, a2: 'qqq', a3: 1.11 }, test2: 12 }
    });
  });
});
