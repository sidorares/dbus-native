var put = require('put');
var binary = require('binary');
var parseSignature = require('./signature');

//var constants = require('./constants');
//var clientMsgTypes = constants.clientMsgTypes;
//var encodings = constants.encodings;

var exports = module.exports = function (signature, callback) {
        var bs = this;
        var args = parseSignature(signature);
        readStruct(bs, args, callback);
}

function read(bs, tree, callback)
{
    switch (tree.type) {
    case '(':
        return readStruct(bs, tree.child, callback);
    case '[':
        if (!tree.child || tree.child.length != 1)
            throw new Error('Incorrect array element signature');
        bs.word32le('length').buffer('arrayBuffer', 'length').tap(function(vars) {
            var arrayBuffer = binary(vars.arrayBuffer);
            return readArray(arrayBuffer, tree.child[0], callback); 
        });
    default:
        readSimpleType(bs, tree.type, callback);
    } 
}

function readStruct(bs, struct, callback)
{
    var result = [];
    if (struct.length == 0)
        callback(null, result);
   
    function readElement(index) {   
        read(bs, struct[index], function(err, value) {
            if (err)
                return callback(err);
            result.push(value);
            if (index + 1 < struct.length) {
                readElement(index + 1);
            } else {
                callback(null, result);
            }
        });
    }
    readElement(0);
}

function readArray(bs, ele, callback)
{
    var result = [];
    function readElement() {
        if (!bs.eof()) {
           read(bs, ele, function(err, value) {
               if (err)
                   return callback(err);
               result.push(value);
               readElement();
           });
        } else {
           callback(null, result);
        }
    }
    readElement();
}

function readSimpleType(bs, t, callback) 
{
    switch (t) {
    case 'y':
        return bs.word8('param').tap(function(vars) { callback(null, vars.param) });
    case 'u':
    case 'b':
        return bs.word32le('param').tap(function(vars) { 
            if (t === 'b' && !isValidBoolean(vars.param))
                callback(new Error('booleans are allowed to be 0 or 1'));
            else
                callback(null, vars.param) 
        });
    case 'g':
        return bs.word8('length').tap(function(vars) { 
            bs.buffer('signature', vars.length + 1).tap(function(vars) {
                var sig = vars.signature.slice(0, -1).toString('ascii');
                callback(null, sig)
            });
        });
    case 's':
    case 'o':
        return bs.word32le('length').tap(function(vars) {
            var len = vars.length;
            // 4 bytes alignment
            var padded = ((len+1 + 3) >> 2) << 2;
            bs.buffer('buff', padded).tap(function(vars) {
                var str = vars.buff.slice(0, len-padded).toString('utf8');
                if (t === 'o' && !isValidObjectPath(str))
                    return callback(new Error('string is not a valid object path'));
                else return callback(null, str);
            });
        });
    default: callback(new Error('Unsupported type:' + t));
    }
}

function isValidBoolean(val)
{
   return val === 1 || val === 0;
}
/*
   http://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-marshaling   

   The following rules define a valid object path. 
   Implementations must not send or accept messages with invalid object paths.
   - The path may be of any length.
   - The path must begin with an ASCII '/' 
     (integer 47) character, and must consist of elements 
     separated by slash characters.
   - Each element must only contain the ASCII characters "[A-Z][a-z][0-9]_"
   - No element may be the empty string.
   - Multiple '/' characters cannot occur in sequence.
   - A trailing '/' character is not allowed unless the path is the root path (a single '/' character).
*/
// the above is copy-paste from spec. I believe they meant /^(\/$)|(\/[A-Za-z0-9_]+)+$/
function isValidObjectPath(path) {
   return path.match(/^(\/$)|(\/[A-Za-z0-9_]+)+$/);
}
