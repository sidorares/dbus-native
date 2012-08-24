var assert = require('assert');

var parseSignature = require('./signature');
var put = require('put');

var marshall = module.exports = function(signature, data) {
    //console.log(signature, data);
    var tree = parseSignature(signature);
    var putstream = put();
    putstream._offset = 0;
    var buf = writeStruct(putstream, tree, data).buffer();
    //console.log(buf, buf.toString('hex'));
    return buf;
}

function writeStruct(ps, tree, data)
{
    //console.log('WRITE STRUCT', tree, data);
    for (var i=0; i < tree.length; ++i) {
       write(ps, tree[i], data[i]);
    }
    //console.log('WRITE STRUCT DONE', ps._offset);
    return ps;
}

function write(ps, ele, data) {
    //console.log('WRITE:', ele, data, ps._offset);
    switch(ele.type) {
    case '(':
        align(ps, 8);
        writeStruct(ps, ele.child, data);
        break;
    case 'a':
        var arrPut = put();
        arrPut._offset = 0; //ps._offset;
        //console.log(["ARRAY:", data])
        for(var i=0; i < data.length; ++i)
            write(arrPut, ele.child[0], data[i]);
        var arrBuff = arrPut.buffer();
        //console.log('ARRAY', arrBuff.length);
        writeSimple(ps, 'u', arrBuff.length);
        ps.put(arrBuff);
        ps._offset += arrBuff.length; 
        break;
    case 'v':
        //console.log([' ===== VARIANT ', ele, data]);
        assert.equal(data.length, 2, "variant data should be [signature, data]");
        var signatureEle = { type: 'g', child: [] };
        write(ps, signatureEle, data[0]);
        var variantEle = { type: data[0], child: [] };
        write(ps, variantEle, data[1]);
        break;
    default:
        return writeSimple(ps, ele.type, data);    
    }
}

function align(ps, n)
{
    //console.log('ALIGN CALLED AT ', ps._offset);
    var pad = n - ps._offset % n;
    if (pad === 0 || pad === n)
        return;
    //console.log("Added align: ", pad, ps._offset);
    // TODO: write8(0) in a loop (3 to 7 times here) could be more efficient 
    var padBuff = Buffer(pad);
    padBuff.fill(0);
    ps.put(Buffer(padBuff));
    ps._offset += pad;
}

function writeSimple(ps, type, data) {
    ////console.log(['WRITE SIMPLE', type, data, ps._offset]);
    switch(type) {
    case 'y':   // byte
        ps.word8(data);
        ps._offset++;
        //console.log(['DONE y', ps._offset]);
        break;
    case 'u':   // 32 bit unsigned int
        align(ps, 4);
        ps.word32le(data);
        ps._offset += 4; 
        //console.log(['DONE u', ps._offset]);
        break;
    case 'g':   // signature
        var buff = new Buffer(data, 'ascii');
        ps.word8(data.length).put(buff).word8(0);
        ps._offset += 2 + buff.length;
        //console.log(['DONE g', ps._offset]);
        break;
    case 'o':   // object path
        // TODO: verify object path here?
    case 's':   // utf8 string
        //console.log("WRITE S", data);
        align(ps, 4);
        var buff = Buffer(data, 'utf8');
        //console.log('Buff len: ', buff.length.toString(16))
        ps.word32le(data.length).put(buff).word8(0); 
        ps._offset += 5 + buff.length;
        //console.log(['DONE o/s', ps._offset]);
        break;
    };
    //console.log('WRITTEN:', type, data, ps._offset);
    return ps;
}
