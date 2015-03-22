/**
 * MakeSimpleValidator
 * @param signature - the signature of the data you want to check
 * @returns a simple validator with the "check" method
 *
 * check returns nothing - it only raises errors if the data is
 * invalid for the signature
 */
var MakeSimpleValidator = function(signature) {
    var validator = {};
    switch(signature) {
        case 'y':
            //BYTE
            validator.check = function(data) {
                checkInteger(data);
                checkRange(0x00,0xFF,data);
            };
            break;
        case 'b':
            //BOOLEAN
            validator.check = function(data) {
                checkBoolean(data);
            };
            break;
        default:
            // TODO
            // until all signatures are complete we will have a check
            // that does nothing
            validator.check = function() {};
    }
    return validator;
};
exports.MakeSimpleValidator = MakeSimpleValidator;

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
