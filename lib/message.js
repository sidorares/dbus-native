var binary = require('binary');

var unmarshall = require('./unmarshall');
var   marshall = require('./marshall');
var constants  = require('./constants');


var read = module.exports.read = function(dbus, opts) {
    var binarystream = this;

    unmarshall.call(binarystream, constants.messageSignature, 0, function(err, data) {
        if (err)
            return dbus.emit('error', err);
 
        // TODO: 1,2,3,5,6 are part of messageSignature. Move to constants?
        var message = {
            type: data[1],
            flags: data[2],
            serial: data[5]
        };

        var bodyLength =  data[4];
        data[6].forEach(function(header) {
            var typeName = constants.headerTypeName[header[0]];
            message[typeName] = header[1][1][0];
        });
        
        /*
            The length of the header must be a multiple of 8, 
            allowing the body to begin on an 8-byte boundary when 
            storing the entire message in a single buffer. If the 
            header does not naturally end on an 8-byte boundary 
            up to 7 bytes of nul-initialized alignment padding 
            must be added.

            The message body need not end on an 8-byte boundary.
        */
        unmarshall.align(binarystream, 3);  // 2^3
        
        // read body
        
        if (typeof message.signature === 'undefined')
            message.signature = "";

        // TODO: emit header before reading body?
        //dbus.emit("header", message);
 
        if (bodyLength === 0) {
            dbus.emit('message', message); 
            read.call(binarystream, dbus, opts);
            return;
        }
         
        binarystream.buffer('bodyBuffer', bodyLength).tap(function(vars) {
            var bodyStream = binary(vars.bodyBuffer);
            unmarshall.call(bodyStream, message.signature, 0, function(err, data) {
                if (err)
                    dbus.emit('error', err); // TODO: throw error instead of firing event?
                message.body = data;
                dbus.emit('message', message);
                if (binarystream.eof && binarystream.eof())
                  return;

                // wait next message
                read.call(binarystream, dbus, opts);
            });
        });
    });
};

module.exports.write = function(message) {
    var dbus = this;
    //if (!dbus.serial) dbus.serial = 1; // TODO: move up
    if (!message.serial) message.serial = 1;
    var flags = message.flags || 0;
    var type = message.type || constants.messageType.methodCall;
    var bodyLength = 0;
    var bodyBuff;
    if (message.body) {
        bodyBuff = marshall(message.signature, message.body);
        bodyLength = bodyBuff.length;
    }
    var header = [ constants.endianness.le, type, flags, constants.protocolVersion, bodyLength, message.serial ];
    var headerBuff = marshall('yyyyuu', header);
    var fields = [];
    constants.headerTypeName.forEach( function(fieldName) {
        var fieldVal = message[fieldName];
        if (fieldVal) {
           fields.push([constants.headerTypeId[fieldName], [constants.fieldSignature[fieldName], fieldVal]]);
        }
    });
    var fieldsBuff = marshall('a(yv)', [fields], 12);
    var headerLenAligned = ((headerBuff.length +  fieldsBuff.length + 7) >> 3) << 3;
    var messageLen = headerLenAligned + bodyLength;
    var messageBuff = Buffer(messageLen); 
    messageBuff.fill(0);
    headerBuff.copy(messageBuff);
    fieldsBuff.copy(messageBuff, headerBuff.length);
    if (bodyLength > 0)
        bodyBuff.copy(messageBuff, headerLenAligned);
   
    dbus.write(messageBuff);

    //var hexy = require('../hexy');
    //console.error(hexy.hexy(messageBuff, {prefix: 'message  '}));     
};
