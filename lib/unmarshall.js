var put = require('put');
var binary = require('binary');
var parseSignature = require('./signature');
var assert = require('assert');

var exports = module.exports = function (signature, offset, callback) {
    var bs = this;
    if (signature === "")
        return callback(null, null);
    var args = parseSignature(signature);
    bs.globalOffset = offset;
    readStruct(bs, args, callback);
};

var align = module.exports.align = function align(bs, power) {
    var allbits = (1<<power) - 1;
    var paddedOffset = ((bs.globalOffset + allbits) >> power) << power;
    var toAlign = paddedOffset - bs.globalOffset;
    if (toAlign !== 0) {
        bs.globalOffset += toAlign;
        bs.skip(toAlign);
    }
};

function read(bs, tree, callback) {
    switch (tree.type) {
        case '(':
        case '{':
            align(bs, 3); // align to 8 bytes boundary
            return readStruct(bs, tree.child, callback);

        case 'a':
            if (!tree.child || tree.child.length != 1)
                throw new Error('Incorrect array element signature');
            align(bs, 2);
            return bs.word32le('length').tap(function(vars) {
                var arrayBlobLength = vars.length;
                bs.globalOffset += 4;
                if (['x', 't', 'd', '{', '('].indexOf(tree.child[0].type) != -1) {
                    align(bs, 3);
                }
                bs.buffer('arrayBuffer', arrayBlobLength).tap(function(_vars) {
                    var arrayBuffer = binary(_vars.arrayBuffer);
                    arrayBuffer.globalOffset = bs.globalOffset;
                    var readArrayOrObject = tree.child[0].type === '{' ? readObject : readArray;
                    readArrayOrObject(arrayBuffer, tree.child[0], function(err, value) {
                        bs.globalOffset += arrayBlobLength;
                        callback(err, value);
                    });
                });
            });
        case 'v':
            return readVariant(bs, callback);
        default:
            return readSimpleType(bs, tree.type, callback);
    }
}

function readVariant(bs, callback) {
    readSimpleType(bs, 'g', function(err, val) {
        if (err)
            return callback(err);

        var args, tree;

        try {  // TODO use CPS-style for parseSignature for consistency?
            args = parseSignature(val);

            if (args.length !== 1)
                throw new Error('Bad "variant" signature: Expected a single complete type');

            tree = args[0];
        } catch(err) {
            return callback(err);
        }

        read(bs, tree, function(err, val) {
            if (err)
                return callback(err);
            return callback(null, val);
        });
    });
}

function readStruct(bs, struct, callback) {
    var result = [];
    function readElement(index) {
        if (index < struct.length) {
            read(bs, struct[index], function(err, value) {
                if (err) {
                    return callback(err);
                }
                result.push(value);
                readElement(index + 1);
            });
        } else {
            callback(null, result);
        }
    }
    readElement(0);
}

function readArray(bs, ele, callback) {
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

function readObject(bs, ele, callback) {
    var result = {};
    function readElement() {
        if (!bs.eof()) {
            read(bs, ele, function(err, dictEntry) {
                if (err)
                    return callback(err);
                var key = dictEntry[0];
                var value = dictEntry[1];
                result[key] = value;
                readElement();
            });
        } else {
            return callback(null, result);
        }
    }
    readElement();
}

function readSimpleType(bs, t, callback) {
    switch (t) {
        case 'y': // BYTE
            bs.globalOffset += 1;
            return bs.word8('param').tap(function(vars) { callback(null, vars.param); });
        case 'n': // INT16
            align(bs, 1);
            bs.globalOffset += 2;
            return bs.word16ls('param').tap(function(vars) { callback(null, vars.param); });
        case 'q': // UINT16
            align(bs, 1);
            bs.globalOffset += 2;
            return bs.word16le('param').tap(function(vars) { callback(null, vars.param); });
        case 'i': // INT32
            align(bs, 2);
            bs.globalOffset += 4;
            return bs.word32ls('param').tap(function(vars) { callback(null, vars.param); });
        case 'u': // UINT32
            align(bs, 2);
            bs.globalOffset += 4;
            return bs.word32le('param').tap(function(vars) { callback(null, vars.param); });
        case 'b': // BOOLEAN
            align(bs, 2);
            bs.globalOffset += 4;
            return bs.word32le('param').tap(function(vars) {
                if (isValidBoolean(vars.param)) {
                    callback(null, !!vars.param);
                } else {
                    callback(new Error('Failed to read boolean: expected 0 or 1'));
                }
            });
        case 'g': // SIGNATURE
            return bs.word8('length').tap(function(vars) {
                bs.buffer('signature', vars.length + 1).tap(function(vars) {
                    bs.globalOffset += vars.length + 2; // 1 byte length + null terminator
                    var sig = vars.signature.slice(0, vars.length).toString('ascii');
                    callback(null, sig);
                });
            });
        case 's': // STRING
        case 'o': // OBJECT_PATH
            align(bs, 2);
            return bs.word32le('length').tap(function(vars) {
                var len = vars.length;
                bs.buffer('buff', len + 1).tap(function(vars) {
                    bs.globalOffset += len + 5; // 4 bytes length + null terminator
                    var str = vars.buff.slice(0, vars.buff.length - 1).toString('utf8');
                    if (t === 'o' && !isValidObjectPath(str)) {
                        return callback(new Error('Failed to read object path: Invalid'));
                    } else {
                        return callback(null, str);
                    }
                });
            });
        case 'x': // INT64
            align(bs, 3);
            bs.globalOffset += 8;
            return bs.word64ls('param').tap(function(vars) { callback(null, vars.param); });
        case 't': // UINT64
            align(bs, 3);
            bs.globalOffset += 8;
            return bs.word64le('param').tap(function(vars) { callback(null, vars.param); });
        case 'd': // DOUBLE
            align(bs, 3);
            bs.globalOffset += 8;
            return bs.buffer('param', 8).tap(function(vars) { callback(null, vars.param.readDoubleLE(0)); });
        default:
            return callback(new Error('Unsupported type:' + t));
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
