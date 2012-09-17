var marshall = require('../lib/marshall');
var unmarshall = require('../lib/unmarshall');
var binary = require('binary');
var assert = require('assert');
var hexy = require('../lib/hexy').hexy;

function test() {};

function testOnly(signature, data, callback) {
    console.log(signature, data);
    var marshalledBuffer = marshall(signature, data);
    console.error(hexy(marshalledBuffer, {prefix: '===='}));
    var stream = binary(marshalledBuffer);
    unmarshall.call(stream, signature, function(err, result) {
        assert.equal(err, null);
        console.log('SIGNATURE:', signature, data);
        assert.deepEqual(data, result);
        console.log('=========================');
        console.log(data, result);
    });
}
var str300chars = '';
for (var i=0; i < 300; ++i)
   str300chars += 'x';

// simple types
test('s', ['short string']);
test('o', ['/object/path']);
test('o', ['invalid/object/path']);
test('g', ['xxxtt[t]s{u}uuiibb']); 
//test('g', ['signature']); // TODO: validate on input
//test('g', [str300chars]); // max 255 chars
test('o', ['/']);
test('b', [true]);
test('b', [false]);
test('y', [10]);
//test('y', [300]);  // TODO: validate on input
//test('y', [-10]);  // TODO: validate on input
test('n', [300]); 
test('n', [16300]);
//test('n', [65535]); // TODO: signed 16 bit
//test('n', [-100]);  // TODO: validate on input, should fail
test('q', [65535]);
//test('q', [-100]);  // TODO: validate on input, should fail

// i - signed, u - unsigned
test('i', [1048576]);
test('i', [0]);
test('i', [-1]);
test('u', [1048576]);
test('u', [0]);
//test('u', [-1]);  // TODO validate input, should fail

// structs with different offsets
test('{yyy}y', [[1, 2, 3], 4]);
test('y{yyy}y', [5, [1, 2, 3], 4]);
test('yy{yyy}y', [5, 6, [1, 2, 3], 4]);
test('yyy{yyy}y', [5, 6, 7, [1, 2, 3], 4]);
test('yyyy{yyy}y', [5, 6, 7, 8, [1, 2, 3], 4]);
test('yyyyy{yyy}y', [5, 6, 7, 8, 9, [1, 2, 3], 4]);

intTypes = ['y', 'n', 'q', 'i', 'u']; //, 'x', 't'];
for (var t1 = 0; t1 < intTypes.length; ++t1)
  for (var t2 = 0; t2 < intTypes.length; ++t2)
  {
      test(intTypes[t1] + intTypes[t2], [1, 2]);
  }

// arrays

test('ai', [[]]);
test('aai', [[[]]]);
test('ai', [[1, 2, 3, 4, 5, 6, 7]]);
test('aiay', [[300, 400, 500], [1, 2, 3, 4, 5, 6, 7]]);
testOnly('ayai', [[1, 2, 3], [300, 400, 500]]);



// TODO: epsilon-test floats
//test('bdsai', [0, 3.141590118408203, 'test string', [1, 2, 3, 0, 0, 0, 4, 5, 6, 7]]);

// np test('sa(iyai)', ['test test test test', [[10, 100, [1, 2, 3, 4, 5, 6]], [11, 200, [15, 4, 5, 6]]]]);
// np test('a(iyai)', [[[10, 100, [1, 2, 3, 4, 5, 6]], [11, 200, [15, 4, 5, 6]]]]);
// np test('a(yai)', [[[100, [1, 2, 3, 4, 5, 6]], [200, [15, 4, 5, 6]]]]);

// pass test('ai', [[1, 2, 3, 4, 5, 6]]);
// pass test('aii', [[1, 2, 3, 4, 5, 6], 10]);

// np test('a(ai)', [[  [[1, 2, 3, 4, 5, 6]], [[15, 4, 5, 6]] ]]);
// pass test('aai', [[[1, 2, 3, 4, 5, 6], [15, 4, 5, 6]]]);

// pass test('iyai', [10, 100, [1, 2, 3, 4, 5, 6]]);
