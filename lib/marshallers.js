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
    switch(signature) {
        case 's':
            //STRING
            marshaller.check = function(data) {
                if (typeof(data) !== "string") {
                    throw new Error("Data: " + data + " was not of type string");
                }
                else if (data.indexOf("\0") !== -1) {
                    throw new Error("String contains null byte");
                }
            };
            break;
        case 'y':
            //BYTE
            marshaller.check = function(data) {
                checkInteger(data);
                checkRange(0x00,0xFF,data);
            };
            break;
        case 'b':
            //BOOLEAN
            marshaller.check = function(data) {
                checkBoolean(data);
            };
            break;
        case 'n':
            //INT16
            marshaller.check = function(data) {
                checkInteger(data);
                checkRange(-0x7FFF-1,0x7FFF,data);
            };
            break;
        case 'q':
            //UINT16
            marshaller.check = function(data) {
                checkInteger(data);
                checkRange(0,0xFFFF,data);
            };
            break;
        case 'i':
            //INT32
            marshaller.check = function(data) {
                checkInteger(data);
                checkRange(-0x7FFFFFFF-1,0x7FFFFFFF,data);
            };
            break;
        case 'u':
            //UINT32
            marshaller.check = function(data) {
                checkInteger(data);
                checkRange(0,0xFFFFFFFF,data);
            };
            break;
        case 't':
            //UINT64
            marshaller.check = function(data) {
                throw new Error("64 Bit integers not supported");
            };
            break;
        case 'x':
            //INT64
            marshaller.check = function(data) {
                throw new Error("64 Bit integers not supported");
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
            break;
        default:
            // TODO
            // until all signatures are complete we will have a check
            // that does nothing
            marshaller.check = function() {};
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
