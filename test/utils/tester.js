var fs = require('fs');
var binarystream = require('binary');
var packets = fs.readFileSync('./packets.bin');
var EventEmitter = require('events').EventEmitter;
var message = require('./lib/message');
var hexy = require('./lib/hexy').hexy;

//var probBody = packets.slice(2544+16*11+16*4+8, 2544+16*11+16*4+8+0x390);
//var stream = fs.createWriteStream('./problembody.bin')
//stream.write(probBody);
//console.log(hexy(probBody, {prefix: 'BODY BODY: '}));

function nextPacketPos(b)
{
    console.log(hexy(b, {prefix: 'SEARCHING : '}));
    if (b.length < 10) {
        console.log('TOO SHORT');
        return -1;
    }
    for (i=1; i < b.length; ++i) {
      if (b.get(i) == 0x6c) {
        console.log('possible match at ' + i, b.get(i+3), b.get(i+1), b.get(i+2), b.get(i+8));
        if (b.get(i+3) == 1 && b.get(i+1) < 5 && b.get(i+2) < 4 && b.get(i+8) < 9)
            return i;
      }
    }
    return -1;

}


if (1) {


function readPacket(offset, data) {
    
    if (offset > data.length)
        return;
    console.log(' ======********====== START : ', offset, data.length);
    console.log(hexy(data.slice(offset, offset+48*8), {prefix: 'BODY BODY: '}));
    console.log(nextPacketPos(data.slice(offset, offset+400)));
    process.exit(0);
    var len = data.readUInt32LE(offset);
    var packet;
    if (len > 100000) {
        packet = data.slice(offset, data.length);
        //console.error(hexy(packet, {prefix: 'problem packet: '}));
        //return
        console.log(hexy(packet, {prefix: 'packet: '}));    
        debugger;
    } else {
        console.log("SLICING:", len, offset+4, offset+len+4);
        packet = data.slice(offset+4, offset+len+4);
        console.log(hexy(packet, {prefix: 'packet: '}));    
    }
    var dbus = new EventEmitter();
    var stream = binarystream.parse(packet);
    dbus.on('message', function(msg) {
        console.log(msg);
        console.log('==================== ', data.length, offset, 4 + packet.length);
        readPacket(offset + 4 + packet.length, data);
    });
    dbus.on('header', function(msg) {
        console.log('header: ', msg);
        if (msg.signature.length > 1) {
            debugger;
        }
    });
    message.read.call(stream, dbus);
}

readPacket(0x02e0+15*9-1, packets);

}
