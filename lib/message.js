var binary = require('binary');

var unmarshall = require('./unmarshall');
var constants  = require('./constants');


var read = module.exports.read = function(dbus, opts) {
    var binarystream = this;

    unmarshall.call(binarystream, constants.messageSignature, function(err, data) {
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
        unmarshall.align(binarystream, 3);
        
        // read body
        
        if (typeof message.signature === 'undefined')
            message.signature = "";
        
        unmarshall.call(binarystream, message.signature, function(err, data) {
            if (err)
                dbus.emit('error', err); // TODO: throw error instead of firing event?
            message.body = data;
            console.log(message)
            dbus.emit('message', message);
            // wait next message
            read.call(binarystream, dbus, opts);
        });
    });
};

module.exports.write = function(dbus, message) {
}
