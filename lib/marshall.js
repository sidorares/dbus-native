var parseSignature = require('./signature');
var put = require('put');

var marshall = module.exports = function(signature, data) {
    console.log(signature, data);
    var tree = parseSignature(signature);
    var putstream = put();
    putstream.offset = 0;
    var buf =  writeStruct(putstream, tree, data).buffer();
    console.log(buf);
    return buf;
}

function writeStruct(ps, tree, data)
{
    for (var i=0; i < tree.length; ++i)
       write(ps, tree[i], data[i]);
    return ps;
}

function write(ps, ele, data) {
    switch(ele.type) {
    case '(':
        var arrPut = put();
        arrPut.offset = ps.offset;
        for(var i=0; i < data.length; ++i);
            write(arrPut, ele.children[0], data[i]);
        var arrBuff = arrPut.buffer();
    default:
        return writeSimple(ps, ele, data);    
    }
}

function writeSimple(ps, type, data) {
    switch(type) {
    case 'y': ps.word8(data); break;
    case 'u': 
              // align on 4 bytes boundary
              ps.word32le(data);
    case 'g': ps.word8(data.length + 1).put(new Buffer(data)).word8(0); break;
    case 'o':
    case 's': ps.word32le(data.length + 1).put(new Buffer(data)).word8(0); break;
    };
    return ps;
}
