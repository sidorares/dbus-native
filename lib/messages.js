var binary = require('binary');

//var constants = require('./constants');
//var clientMsgTypes = constants.clientMsgTypes;
//var encodings = constants.encodings;

function int32buf(bs, cb)
{
    bs
      .word32le('length')
      .tap(function(vars) {
         this.buffer('buf', vars.length)
         this.tap(function(vars) {
             console.log('32-prefixed buf', [vars.length, vars.buf]);
             cb(vars.buf);
         });
      });
}

function int8buf(bs, cb)
{
    bs
      .word8le('length')
      .tap(function(vars) {
         this.buffer('buf', vars.length)
         this.tap(function(vars) {
             console.log('8-prefixed buf', [vars.length, vars.buf]);
             cb(vars.buf);
         });
      });
}

function int32str(bs, type, cb)
{
    bs
      .word32le('length')
      .tap(function(vars) {
         var len = vars.length;
         var padded = ((len+1 + 3) >> 2) << 2 
         this.buffer('buf', padded);
         console.log('STRING: ', len, padded, len-padded);
         this.tap(function(vars) {
             var val = vars.buf.slice(len-padded).toString(type);
             console.log('STRING:', val);
             cb(val);
         });
      });
}

function int8str(bs, type, cb)
{
    bs
      .word8le('length')
      .tap(function(vars) {
         var len = vars.length;
         this.buffer('buf', len+1);
         this.tap(function(vars) {
             var val = vars.buf.slice(-1).toString(type);
             console.log('STRING:', val);
             cb(val);
         });
      });
}

var exports = module.exports = function readMessage(dbus, opts) {
    var binarystream = this;
    //unmarshall.call(binarystream, 'yyyyuuav', function(err, data) {
    //});

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
