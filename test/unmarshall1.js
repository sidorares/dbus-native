var hexy = require('../lib/hexy').hexy;
var unmarshall = require('../lib/unmarshall');
var signature = "a(ssasib)";
var common = require('./common');

var data = require('fs').readFileSync(common.fixturesDir + '/problembody.bin');
var bufstream = require('binary').parse(data);

// TODO: mochify, re-enable after array of structs offset fixed

//unmarshall.call(bufstream, signature, 0, function(err, result) {
//    console.log(result);
//    console.error(hexy(data, {prefix: '===='}));
//});
