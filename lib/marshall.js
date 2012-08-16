var put = require('put');
var binary = require('binary');
var hexy = require('./hexy').hexy;

//var constants = require('./constants');
//var clientMsgTypes = constants.clientMsgTypes;
//var encodings = constants.encodings;


var exports = module.exports = {
    unmarshall: function (stream, signature) {
    var binarystream = this;
    binarystream
        .word8('endianness')  // TODO: use endianness!
        .word8('messageType')
        .word8('flags')
        .word8('protocolVersion')
        .word32le('bodyLength')
        .word32le('serial');
    
    int32buf(binarystream, function(header) {
        var headerStream = binary(header);
        function readHeaderField()
        {
            if (headerStream.eof()) {
                console.log('done header');
                return;
            }
            headerStream.word8('headerType'); // the rest should be generic 'read variant'
            int8str(headerStream, 'ascii', function(sig) {
                //switch(s) {
                //case 's':
                //}
                console.log('SIGNATURE:', sig);
                int32str(headerStream, 'utf8', function(param) {
                    console.log('PARAM: ', param);
                    readHeaderField();
                });
            });
        };
        readHeaderField();
    });
};
