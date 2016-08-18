var marshall = require('../lib/marshall');
var unmarshall = require('../lib/unmarshall');
var assert = require('assert');

/** Take the data and marshall it then unmarshall it */
function marshallAndUnmarshall (signature, data) {
  var marshalledBuffer = marshall(signature, data);
  var result = unmarshall(marshalledBuffer, signature);
  return result;
}

function test (signature, data) {
  var result = marshallAndUnmarshall(signature, data);
  try {
    assert.deepEqual(data, result);
  } catch (e) {
    console.log('signature   :', signature);
    console.log('orig        :', data);
    console.log('unmarshalled:', result);
    throw new Error('results don\'t match');
  }
}

var str300chars = '';
for (var i = 0; i < 300; ++i) {
  str300chars += 'i';
}

var b30000bytes = Buffer(30000);
b30000bytes.fill(60);
// TODO (eslint): never used
var str30000chars = b30000bytes.toString('ascii');

if (typeof describe === 'undefined') {
  global.describe = function () {};
}

function expectMarshallToThrowOnBadArguments (badSig, badData, errorRegex) {
  assert.throws(function () {
    marshall(badSig, badData);
  }, errorRegex);
}

describe('marshall', function () {
  it('throws error on bad data', function () {
    var badData = [
                        ['s', [3], /Expected string or buffer argument/],
                        ['s', ['as\0df'], /String contains null byte/],
                        ['g', [3], /Expected string or buffer argument/],
                        ['g', ['ccc'], /Unknown type.*in signature.*/],
                        ['g', ['as\0df'], /String contains null byte/],
                        ['g', [str300chars], /Data:.* is too long for signature type/],
                        ['g', ['iii(i'], /Bad signature: unexpected end/],
                        ['g', ['iii{i'], /Bad signature: unexpected end/],
                        ['g', ['i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i(i)))))))))))))))))))))))))))))))))'], /Maximum container type nesting exceeded/],
                        ['y', ['n'], /Data:.*was not of type number/],
                        ['y', [-1], /Number outside range/],
                        ['y', [1.5], /Data:.*was not an integer/],
                        ['y', [256], /Number outside range/],
                        ['b', ['n'], /Data:.*was not of type boolean/],
                        ['b', [-1], /Data:.*was not of type boolean/],
                        ['b', [0.5], /Data:.*was not of type boolean/],
                        ['b', [2], /Data:.*was not of type boolean/],
                        ['n', ['n'], /Data:.*was not of type number/],
                        ['n', [(-0x7FFF - 2)], /Number outside range/],
                        ['n', [1.5], /Data:.*was not an integer/],
                        ['n', [(0x7FFF + 1)], /Number outside range/],
                        ['q', ['n'], /Data:.*was not of type number/],
                        ['q', [-1], /Number outside range/],
                        ['q', [1.5], /Data:.*was not an integer/],
                        ['q', [(0xFFFF + 1)], /Number outside range/],
                        ['i', ['n'], /Data:.*was not of type number/],
                        ['i', [(-0x7FFFFFFF - 2)], /Number outside range/],
                        ['i', [1.5], /Data:.*was not an integer/],
                        ['i', [(0x7FFFFFFF + 1)], /Number outside range/],
                        ['u', ['n'], /Data:.*was not of type number/],
                        ['u', [(-1)], /Number outside range/],
                        ['u', [1.5], /Data:.*was not an integer/],
                        ['u', [(0xFFFFFFFF + 1)], /Number outside range/],
                        ['x', ['n'], /64 Bit integers not supported/],
                        ['x', [(-(Math.pow(2, 53)) - 1)], /64 Bit integers not supported/],
                        ['x', [1.5], /64 Bit integers not supported/],
                        ['x', [(Math.pow(2, 53))], /64 Bit integers not supported/],
                        ['t', ['n'], /64 Bit integers not supported/],
                        ['t', [(-1)], /64 Bit integers not supported/],
                        ['t', [1.5], /64 Bit integers not supported/],
                        ['t', [(Math.pow(2, 53))], /64 Bit integers not supported/],
                        ['d', ['n'], /Data:.*was not of type number/],
                        ['d', [Number.NEGATIVE_INFINITY], /Number outside range/],
                        ['d', [NaN], /Data:.*was not a number/],
                        ['d', [Number.POSITIVE_INFINITY], /Number outside range/]
    ];
    for (var ii = 0; ii < badData.length; ++ii) {
      var badRow = badData[ii];
      var badSig = badRow[0];
      var badDatum = badRow[1];
      var errorRegex = badRow[2];
      expectMarshallToThrowOnBadArguments(badSig, badDatum, errorRegex);
    }
  });
  it('throws error on bad signature', function () {
    var badSig = '1';
    var badData = 1;
    expectMarshallToThrowOnBadArguments(badSig, badData, /Unknown type.*in signature.*/);
  });
});

describe('marshall/unmarshall', function () {

   // signature, data, not expected to fail?, data after unmarshall (when expected to convert to canonic form and different from input)
  var tests = {
    'simple types': [
         ['s', ['short string']],
         ['s', ['str30000chars']],
         ['o', ['/object/path']],
         ['o', ['invalid/object/path'], false],
         ['g', ['xxxtt(t)s{u}uuiibb']],
         ['g', ['signature'], false], // TODO: validate on input
         // ['g', [str300chars], false],  // max 255 chars
         ['o', ['/']],
         ['b', [0]],
         ['b', [1]],
         // ['b', [true], true, 1],
         // ['b', [false], true, 0],
         ['y', [10]],
         // ['y', [300], false],  // TODO: validate on input
         // ['y', [-10]],  // TODO: validate on input
         ['n', [300]],
         ['n', [16300]],
         // ['n', [65535], false] // TODO: signed 16 bit
         // ['n', [-100], false];  // TODO: validate on input, should fail
         ['q', [65535]],
         // ['q', [-100], false],   // TODO: validate on input, should fail
         // i - signed, u - unsigned
         ['i', [1048576]],
         ['i', [0]],
         ['i', [-1]],
         ['u', [1048576]],
         ['u', [0]]
         // ['u', [-1], false]  // TODO validate input, should fail
    ],
    'simple structs': [
         ['(yyy)y', [[1, 2, 3], 4]],
         ['y(yyy)y', [5, [1, 2, 3], 4]],
         ['yy(yyy)y', [5, 6, [1, 2, 3], 4]],
         ['yyy(yyy)y', [5, 6, 7, [1, 2, 3], 4]],
         ['yyyy(yyy)y', [5, 6, 7, 8, [1, 2, 3], 4]],
         ['yyyyy(yyy)y', [5, 6, 7, 8, 9, [1, 2, 3], 4]]
    ],
    'arrays of simple types': [
         ['ai', [[1, 2, 3, 4, 5, 6, 7]]],
         ['aai', [[[300, 400, 500], [1, 2, 3, 4, 5, 6, 7]]]],
         ['aiai', [[1, 2, 3], [300, 400, 500]]]
    ],
    'compound types': [
         ['iyai', [10, 100, [1, 2, 3, 4, 5, 6]]],
         // TODO: fix 'array of structs offset problem
         ['a(iyai)', [[[10, 100, [1, 2, 3, 4, 5, 6]], [11, 200, [15, 4, 5, 6]]]]],
         ['sa(iyai)', ['test test test test', [[10, 100, [1, 2, 3, 4, 5, 6]], [11, 200, [15, 4, 5, 6]]]]],
         ['a(iyai)', [[[10, 100, [1, 2, 3, 4, 5, 6]], [11, 200, [15, 4, 5, 6]]]]],
         ['a(yai)', [[[100, [1, 2, 3, 4, 5, 6]], [200, [15, 4, 5, 6]]]]],
         ['a(yyai)', [[[100, 101, [1, 2, 3, 4, 5, 6]], [200, 201, [15, 4, 5, 6]]]]],
         ['a(yyyai)', [[[100, 101, 102, [1, 2, 3, 4, 5, 6]], [200, 201, 202, [15, 4, 5, 6]]]]],
         ['ai', [[1, 2, 3, 4, 5, 6]]],
         ['aii', [[1, 2, 3, 4, 5, 6], 10]],
         ['a(ai)', [[[[1, 2, 3, 4, 5, 6]], [[15, 4, 5, 6]]]]],
         ['aai', [[[1, 2, 3, 4, 5, 6], [15, 4, 5, 6]]]]
    ]
  };

  var testName, testData, testNum;
  for (testName in tests) {
    for (testNum = 0; testNum < tests[testName].length; ++testNum) {
      testData = tests[testName][testNum];
      var testDesc = testName + ' ' + testNum + ' ' + testData[0] + '<-' + JSON.stringify(testData[1]);
      if (testData[2] === false) // should fail
          {
        (function (testData) {
          it(testDesc, function () {
            test(testData[0], testData[1]);
          });
        })(testData);
      } else {
        (function (testData) {
          it(testDesc, function () {
            test(testData[0], testData[1]);
          });
        })(testData);
      }
    }
  }
});


// test('a(yai)', [[[100,[1,2,3,4,5,6]],[200,[15,4,5,6]]]], console.log);
// test('a(yv)', [[[6,["s","final"]],[8,["g","uuu"]]]], console.log)

// 7 a(ai)<-[[[[1,2,3,4,5,6]],[[15,4,5,6]]]]

/*
test('a(ai)', [
 [
   [[1,2,3,4,5,6]],
   [[7, 7, 4,5,6,7,8,9]]
 ]
], console.log);
*/

/*
test('aai', [
   [
      [1,2,3,4,5,6],
      [7, 7, 4,5,6,7,8,9]
   ]
], console.log);
*/
/*

intTypes = ['y', 'n', 'q', 'i', 'u']; //, 'x', 't'];
for (var t1 = 0; t1 < intTypes.length; ++t1)
  for (var t2 = 0; t2 < intTypes.length; ++t2)
  {
      test(intTypes[t1] + intTypes[t2], [1, 2]);
  }

// arrays

test('ai', [[]]);
test('aai', [[[]]]);



// TODO: epsilon-test floats
// test('bdsai', [0, 3.141590118408203, 'test string', [1, 2, 3, 0, 0, 0, 4, 5, 6, 7]]);

*/
