var marshall   = require('../lib/marshall');
var unmarshall = require('../lib/unmarshall');
var assert     = require('assert');
var hexy       = require('../lib/hexy').hexy;

function testOnly() {};

function test(signature, data) {
    var marshalledBuffer = marshall(signature, data);
    var result = unmarshall(marshalledBuffer, signature)
    try {
      assert.deepEqual(data, result)
    } catch (e) {
      console.log('signature   :', signature);
	    console.log('orig        :', data);
	    console.log('unmarshalled:', result);
      throw new Error('results don\'t match');
	  }
}

describe('when signature is a{sX} and hashAsObject is used', function() {
  xit('serialises to expected value', function() {
    test('a{sv}', { test1: { subobj: { a1: 10, a2: "qqq", a3: 1.11 }, test2: 12 }});
  });
});
