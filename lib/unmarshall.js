var put = require('put');
var binary = require('binary');
var parseSignature = require('./signature');
var assert = require('assert');
//var constants = require('./constants');

var exports = module.exports = function (signature, callback) {
        var bs = this;
        if (signature === "")
            return callback(null, null);
        var args = parseSignature(signature);
        bs.globalOffset = 0;
        readStruct(bs, args, callback);
}

var align = module.exports.align = function align(bs, power) {
    var allbits = (1<<power) - 1;
    var paddedOffset = ((bs.globalOffset + allbits) >> power) << power;
    var toAlign = paddedOffset - bs.globalOffset;
    if (toAlign != 0) {
       bs.globalOffset += toAlign;
       bs.skip(toAlign);
    }
}

function read(bs, tree, callback)
{
    switch (tree.type) {
    case '(':
        align(bs, 3); // align to 8 bytes boundary
        return readStruct(bs, tree.child, callback);
            
    case 'a':
        if (!tree.child || tree.child.length != 1)
            throw new Error('Incorrect array element signature');
        bs.globalOffset += 4;
        bs.word32le('length').buffer('arrayBuffer', 'length').tap(function(vars) {
            var arrayBuffer = binary(vars.arrayBuffer);
            arrayBuffer.globalOffset = 0;
            return readArray(arrayBuffer, tree.child[0], vars.length, function(err, value) {
                bs.globalOffset += vars.length; 
                callback(err, value);
            }); 
        });
        break;
    case 'v':
        return readVariant(bs, callback);
    default:
        readSimpleType(bs, tree.type, callback);
    } 
}

function readVariant(bs, callback)
{
    readSimpleType(bs, 'g', function(err, val) {
        if (err)
           return callback(err);
        var args;
        try {  // TODO use CPS-style for parseSignature for consistency?
            args = parseSignature(val);
        } catch(err) {
            return callback(err);
        }
        readStruct(bs, args, function(err, val) {
            if (err)
                return callback(err);
            return callback(null, [args, val]);
        });
    });
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

function readArray(bs, ele, length, callback)
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
           return callback(null, result);
        }
    }
    readElement();
}

function readSimpleType(bs, t, callback) 
{
    var cb = callback;
    callback = function(err, val) {
        cb(err, val);
    }
    switch (t) {
    case 'y':
        bs.globalOffset += 1;
        return bs.word8('param').tap(function(vars) { callback(null, vars.param) });
    case 'u':
    case 'b':
        align(bs, 2); // align to 4 bytes boundary
        bs.globalOffset += 4;
        return bs.word32le('param').tap(function(vars) { 
            if (t === 'b' && !isValidBoolean(vars.param))
                callback(new Error('booleans are allowed to be 0 or 1'));
            else
                callback(null, vars.param) 
        });
    case 'g':
        return bs.word8('length').tap(function(vars) {
            bs.buffer('signature', vars.length + 1).tap(function(vars) {
                bs.globalOffset += vars.length + 2; // byte length + null terminator
                var sig = vars.signature.slice(0, vars.length).toString('ascii');
                callback(null, sig)
            });
        });
    case 's':
    case 'o':
        align(bs, 2);
        return bs.word32le('length').tap(function(vars) {
            var len = vars.length;
            bs.buffer('buff', len+1).tap(function(vars) {
                bs.globalOffset += len + 5;
                var str = vars.buff.slice(0, len).toString('utf8');
                if (t === 'o' && !isValidObjectPath(str))
                    return callback(new Error('string is not a valid object path'));
                else return callback(null, str);
            });
        });
    default: callback(new Error('Unsupported type:' + t));
    }
}

function isValidBoolean(val) {
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
