var hexy = require('../lib/hexy').hexy;
var unmarshall = require('../lib/unmarshall');
var signature = "a(ssasib)";

var data = require('fs').readFileSync('./fixtures/problembody.bin');
var bufstream = require('binary').parse(data);

unmarshall.call(bufstream, signature, function(err, result) {
    console.log(result);
    console.error(hexy(data, {prefix: '===='}));
});
