var align = require('./align').align;
var parseSignature = require('../lib/signature');
var Long = require('long');
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
                return checkLong(data,false);
            };
            marshaller.marshall = function(ps,data) {
                data = this.check(data);
                align(ps, 8);
                ps.word32le(data.low);
                ps.word32le(data.high);
                ps._offset += 8;
            };
            break;
        case 'x':
            //INT64
            marshaller.check = function(data) {
                return checkLong(data, true);
            };
            marshaller.marshall = function(ps,data) {
                data = this.check(data);
                align(ps, 8);
                ps.word32le(data.low);
                ps.word32le(data.high);
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

// This is essentially a tweaked version of 'fromValue' from Long.js with error checking.
// This can take number or string of decimal characters or 'Long' instance (or Long-style object with props low,high,unsigned).
var makeLong = function(val, signed) {
    if (val instanceof Long) return val;
    if (val instanceof Number) val = val.valueOf();
    if (typeof val === 'number')
    {
        try {   // Long.js won't alert you to precision loss in passing more than 53 bit ints through a double number, so we check here
            checkInteger(val);
            if (signed) checkRange(-0x1fffffffffffff,0x1fffffffffffff,val);
            else checkRange(0,0x1fffffffffffff,val);
        }
        catch (e) { e.message += " (Number type can only carry 53 bit integer)"; throw e; }
        try {return Long.fromNumber(val, !signed);}
        catch (e) { e.message = "Error converting number to 64bit integer '" + e.message + "'"; throw e;}
    }
    if (typeof val === 'string' || val instanceof String)
    {
        var radix = 10;
        val = val.trim().toUpperCase(); // remove extra whitespace and make uppercase (for hex)
        if (val.substring(0,2)==='0X') { // Would anyone do a negative hex like '-0xBEEF' ? Not likely?
            radix = 16;
            val = val.substring(2);
        }
        val = val.replace(/^0+(?=\d)/, ''); // dump leading zeroes
        try {var data = Long.fromString(val, !signed, radix);}
        catch (e) { e.message = "Error converting string to 64bit integer '" + e.message + "'"; throw e;}
        // If string represents a number outside of 64 bit range, it can quietly overflow.
        // We assume if things converted correctly the string coming out of Long should match what went into it.
        if (data.toString(radix).toUpperCase() !== val) throw new Error("Data: '"+ val + "' did not convert correctly to " + (signed?"signed":"unsigned") + " 64 bit");
        return data;
    }
    // Throws for non-objects, converts non-instanceof Long:
    try {return Long.fromBits(val.low, val.high, val.unsigned);}
    catch (e) { e.message = "Error converting object to 64bit integer '" + e.message + "'"; throw e;}
}

var checkLong = function(data, signed) {
    if (!Long.isLong(data)) {
        data = makeLong(data, signed);
    }

    // Do we enforce that Long.js object unsigned/signed match the field even if it is still in range?
    // Probably, might help users avoid unintended bugs?
    if (signed) {
        if (data.unsigned) throw new Error("Longjs object is unsigned, but marshalling into signed 64 bit field");
        if (data.gt(Long.MAX_VALUE) || data.lt(Long.MIN_VALUE)) {
            throw new Error("Data: "+ data + " was out of range (64-bit signed)");
        }
    } else {
        if (!data.unsigned) throw new Error("Longjs object is signed, but marshalling into unsigned 64 bit field");
        // NOTE: data.gt(Long.MAX_UNSIGNED_VALUE) will catch if Long.js object is a signed value but is still within unsigned range!
        //  Since we are enforcing signed type matching between Long.js object and field, this note should not matter.
        if (data.gt(Long.MAX_UNSIGNED_VALUE) || data.lt(0)) {
            throw new Error("Data: "+ data +" was out of range (64-bit unsigned)");
        }
    }
    return data;
};
