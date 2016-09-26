var align = require('./align').align;
var parseSignature = require('../lib/signature');
/**
 * MakeSimpleMarshaller
 * @param signature - the signature of the data you want to check
 * @returns a simple marshaller with the "check" method
 *
 * check returns nothing - it only raises errors if the data is
 * invalid for the signature
 */
var MakeSimpleMarshaller = function(signature) {
    var marshaller = {};
    function checkValidString(data) {
        if (typeof(data) !== "string") {
            throw new Error("Data: " + data + " was not of type string");
        }
        else if (data.indexOf("\0") !== -1) {
            throw new Error("String contains null byte");
        }
    }

    function checkValidSignature(data) {

        if ((data.length) > 0xFF) {
            throw new Error("Data: " + data + " is too long for signature type (" + data.length + " > 255)");
        }

        var parenCount = 0;
        for(var ii = 0; ii < data.length; ++ii) {
            if (parenCount > 32) {
                throw new Error("Maximum container type nesting exceeded in signature type:" + data);
            }
            switch (data[ii]) {
                case "(":
                    ++parenCount;
                    break;
                case ")":
                    --parenCount;
                    break;
                default:
                    /* no-op */
                    break;
            }
        }
        parseSignature(data);
    }

    switch(signature) {
        case 'o':
            // object path
            // TODO: verify object path here?
        case 's':
            //STRING
            marshaller.check = function(data) {
                checkValidString(data);
            };
            marshaller.marshall = function(ps,data) {
                this.check(data);
                // utf8 string
                align(ps, 4);
                buff = new Buffer(data, 'utf8');
                ps.word32le(buff.length).put(buff).word8(0);
                ps._offset += 5 + buff.length;
            };
            break;
        case 'g':
            //SIGNATURE
            marshaller.check = function(data) {
                checkValidString(data);
                checkValidSignature(data);
            };
            marshaller.marshall = function(ps,data) {
                this.check(data);
                // signature
                buff = new Buffer(data, 'ascii');
                ps.word8(data.length).put(buff).word8(0);
                ps._offset += 2 + buff.length;
            };
            break;
        case 'y':
            //BYTE
            marshaller.check = function(data) {
                checkInteger(data);
                checkRange(0x00,0xFF,data);
            };
            marshaller.marshall = function(ps, data) {
                this.check(data);
                ps.word8(data);
                ps._offset++;
            };
            break;
        case 'b':
            //BOOLEAN
            marshaller.check = function(data) {
                checkBoolean(data);
            };
            marshaller.marshall = function(ps, data) {
                this.check(data);
                // booleans serialised as 0/1 unsigned 32 bit int
                if (data) data = 1;
                else data = 0;
                align(ps, 4);
                ps.word32le(data);
                ps._offset += 4;
            };
            break;
        case 'n':
            //INT16
            marshaller.check = function(data) {
                checkInteger(data);
                checkRange(-0x7FFF-1,0x7FFF,data);
            };
            marshaller.marshall = function(ps,data) {
                this.check(data);
                align(ps, 2);
                buff = new Buffer(2);
                buff.writeInt16LE(parseInt(data), 0);
                ps.put(buff);
                ps._offset += 2;
            };
            break;
        case 'q':
            //UINT16
            marshaller.check = function(data) {
                checkInteger(data);
                checkRange(0,0xFFFF,data);
            };
            marshaller.marshall = function(ps,data) {
                this.check(data);
                align(ps, 2);
                ps.word16le(data);
                ps._offset += 2;
            };
            break;
        case 'i':
            //INT32
            marshaller.check = function(data) {
                checkInteger(data);
                checkRange(-0x7FFFFFFF-1,0x7FFFFFFF,data);
            };
            marshaller.marshall = function(ps,data) {
                this.check(data);
                align(ps, 4);
                buff = new Buffer(4);
                buff.writeInt32LE(parseInt(data), 0);
                ps.put(buff);
                ps._offset += 4;
            };
            break;
        case 'u':
            //UINT32
            marshaller.check = function(data) {
                checkInteger(data);
                checkRange(0,0xFFFFFFFF,data);
            };
            marshaller.marshall = function(ps,data) {
                this.check(data);
                // 32 t unsigned int
                align(ps, 4);
                ps.word32le(data);
                ps._offset += 4;
            };
            break;
        case 't':
            //UINT64
            marshaller.check = function(data) {
                throw new Error("64 Bit integers not supported");
            };
            marshaller.marshall = function(ps,data) {
                this.check(data);
                // while the check method will throw an error - this code is left here
                // for when 64 bits will become supported
                align(ps, 8);
                ps.word64le(data);
                ps._offset += 8;
            };
            break;
        case 'x':
            //INT64
            marshaller.check = function(data) {
                throw new Error("64 Bit integers not supported");
            };
            marshaller.marshall = function(ps,data) {
                this.check(data);
                // while the check method will throw an error - this code is left here
                // for when 64 bits will become supported
                ps.word64le(data);
                ps._offset += 8;
            };
            break;
        case 'd':
            //DOUBLE
            marshaller.check = function(data) {
                if (typeof(data) !== "number") {
                    throw new Error("Data: " + data + " was not of type number");
                }
                else if (Number.isNaN(data)) {
                    throw new Error("Data: " + data + " was not a number");
                }
                else if (!Number.isFinite(data)) {
                    throw new Error("Number outside range");
                }
            };
            marshaller.marshall = function(ps,data) {
                this.check(data);
                align(ps, 8);
                buff = new Buffer(8);
                buff.writeDoubleLE(parseFloat(data), 0);
                ps.put(buff);
                ps._offset += 8;
            };
            break;
        default:
            throw new Error('Unknown data type format: ' + type);
    }
    return marshaller;
};
exports.MakeSimpleMarshaller = MakeSimpleMarshaller;

var checkRange = function(minValue, maxValue, data) {
    if ((data > maxValue) || (data < minValue)) {
        throw new Error("Number outside range");
    }
};

var checkInteger = function(data) {
    if (typeof(data)!== "number") {
        throw new Error("Data: "+ data +" was not of type number");
    }
    if (Math.floor(data) !== data) {
        throw new Error("Data: "+ data +" was not an integer");
    }
};

var checkBoolean = function(data) {
    if (!((typeof(data) === "boolean") ||
          ( data === 0 ) ||
          ( data === 1 )))
        throw new Error("Data: "+ data +" was not of type boolean");
};
