// parse signature from string to tree
const utils   = require ('./utils.js')
const Errors  = require ('./Errors.js')
const inspect = require ('util').inspect

const mandatory = utils.mandatory

const RangeError = Errors.RangeError

// Whether to set this file's functions into debugging (verbose) mode
const DEBUG_THIS_FILE = false

// Allows for setting all files to debug in once statement instead of manually setting every flag
const DEBUG = DEBUG_THIS_FILE || utils.GLOBAL_DEBUG


const match = {
  '{' : '}',
  '(' : ')'
}

const knownTypes = {}
'(){}ybnqiuxtdsogarvehm*?@&^'.split('').forEach(function(c) {
  knownTypes[c] = true;
});

const singleTypes = 'ybnqiuxtdsog'

var exports = module.exports = function(signature) {

   var index = 0;
   function next() {
      if (index < signature.length) {
          var c = signature[index];
          ++index;
          return c;
      }
      return null;
   }

   function parseOne(c)
   {
      function checkNotEnd(c) {
          if (!c) throw new Error('Bad signature: unexpected end');
          return c;
      }

      if (!knownTypes[c])
        throw new Error('Unknown type: "' + c + '" in signature "' + signature + '"');

      var ele;
      var res = { type: c, child: [] };
      switch(c) {
      case 'a': // array
          ele = next();
          checkNotEnd(ele);
          res.child.push(parseOne(ele));
          return res;
      case '{': // dict entry
      case '(': // struct
          while(((ele = next()) !== null) && (ele !== match[c]))
             res.child.push(parseOne(ele));
          checkNotEnd(ele);
          return res;
      }
      return res;
   }

   var ret = [];
   var c;
   while ((c = next()) !== null)
       ret.push(parseOne(c));
   return ret;
};

module.exports.fromTree = function(tree) {
  var res = '';
  for (var i=0; i < tree.length; ++i) {
    if (tree[i].child.length === 0)
      res += tree[i].type;
    else {
      if (tree[i].type === 'a') {
        res += 'a' + module.exports.fromTree(tree[i].child);
      } else {
        res += tree[i].type + module.exports.fromTree(tree[i].child) + match[tree[i].type];
      }
    }
  }
  return res;
}

module.exports.valueFromTree = function valueFromTree (msgBody) {
    let tree = msgBody[0]
    let data = msgBody[1]
    let type = tree[0].type

    if (false && DEBUG) {
        console.log ('msgBody:\n', inspect (msgBody, {depth: Infinity}))
    }

    if (DEBUG) {
        console.log ('type: ' + type)
        console.log ('data: ' + data)
    }
    // If the tree contains a single type, just read it and return it
    if (singleTypes.includes (type)) {
        return data[0]
    }
    // If this is an array
    else if (type === 'a') {
        // let ret = [] // initialize empty array
        let ret

        if (DEBUG) {
            console.log ('>>> ARRAY <<<')
            console.log (data)
        }

        ret = data[0]

        if (DEBUG) {
            console.log ('This is what will be returned:\n' + inspect (ret))
        }

        return ret
    }
    // If this is a STRUCT
    else if (type === '(') {
        let ret
        let recursiveRet = []

        if (DEBUG) {
            console.log ('>>> STRUCT <<<')
            console.log (data)
        }

        for (let i in tree[0].child) {
            let rec = [ [ tree[0].child[i] ], [ data[0][i] ] ]

            let recA = valueFromTree (rec)

            // Each recursive return value is pushed to the array (because container data is stored in Javascript arrays)
            if (DEBUG) {
                console.log ('recursiveRet (before): ' + inspect (recursiveRet))
            }
            recursiveRet.push (recA)
            if (DEBUG) {
                console.log ('recursiveRet (after): ' + inspect (recursiveRet))
            }

            if (false && DEBUG) {
                console.log ('Recursive call valueFromTree (' + inspect (rec) + ') = ' + recA)
            }
        }

        /*
            Return 'recursiveRet' as-is for recursivity compatibility. If this is the last call, it must be array-ified
            if needed, as seen in stdifaces.js (look for the comments near the call to 'valueFormTree')
        */
        ret = recursiveRet
        return ret
    }
    else {
        // For unsupported types or errors, return undefined, caller must check for undefined
        if (DEBUG) console.error ('Unsupported complex type!')
        return undefined
    }
}

/*
    Define a signature for supported DBus single types
*/

module.exports.DBUS_BYTE      = DBUS_BYTE      = 'y'
module.exports.DBUS_BOOL      = DBUS_BOOL      = 'b'
module.exports.DBUS_INT16     = DBUS_INT16     = 'n'
module.exports.DBUS_UINT16    = DBUS_UINT16    = 'q'
module.exports.DBUS_INT32     = DBUS_INT32     = 'i'
module.exports.DBUS_UINT32    = DBUS_UINT32    = 'u'
module.exports.DBUS_INT64     = DBUS_INT64     = 'x'
module.exports.DBUS_UINT64    = DBUS_UINT64    = 't'
module.exports.DBUS_DOUBLE    = DBUS_DOUBLE    = 'd'
module.exports.DBUS_UNIX_FD   = DBUS_UNIX_FD   = 'h'
module.exports.DBUS_STRING    = DBUS_STRING    = 's'
module.exports.DBUS_OBJ_PATH  = DBUS_OBJ_PATH  = 'o'
module.exports.DBUS_SIGNATURE = DBUS_SIGNATURE = 'g'

/**
 * Define a signature for a DBus array
 */
module.exports.DBUS_ARRAY = function DBUS_ARRAY (type) {
    let ret = 'a' + type

    if (isValidDBusType (ret))
        return ret
    else
        throw new TypeError (`'${type}' is not a valid DBus type to make an array of.`)
}

/**
 * Define a signature for a DBus DICT
 */
module.exports.DBUS_DICT = function DBUS_DICT (keyType, valueType) {
    let ret =  'a{' + keyType + valueType + '}'

    if (isValidDBusType (ret))
        return ret
    else
        throw new TypeError (`'${keyType}' and/or '${valueType}' are not valid DBus types for a DICT.`)
}

/**
 * Define a signatire for a DBus STRUCT
 */
module.exports.DBUS_STRUCT = function DBUS_STRUCT (...types) {
    let ret = '('
    let allOK = true

    for (let type of types) {
        ret += type
        allOK = allOK && (isValidDBusType (type))
    }

    ret += ')'

    if (allOK)
        return ret
    else
        throw new TypeError (`one (or several) of ${types} is/are not valid DBus types for a STRUCT.`)
}

function isValidSingleType (type) {
    return singleTypes.split('').includes (type)
}

function isVariant (type) {
    return type === 'v'
}

function isValidDBusType (type) {
    // Check if 'type' is a single type (or several single types)
    if (isValidSingleType (type)) return true

    if (type.split('').every(t => isValidSingleType (t) || isVariant (t))) return true

    // Check if 'type' is an array of valid types
    if (type.startsWith ('a')) return isValidDBusType (type.substr(1))

    // Check if 'type' is a structure of valid types
    if (type.startsWith ('(') && type.endsWith (')'))
        return isValidDBusType (type.substr(0, type.length - 1).substr(1)) // remove first and last elems '(' and ')'

    // Check if 'type' is a dict containing valid dbus types
    if (type.startsWith ('{') && type.endsWith ('}') && type.length >= 4) { // 4: '{' (1) + key type (1) + value type (>=1) + '} (1)'
        // In a DICT, the key, which must be the first elements MUST be a single type, so take the first char after the '{'
        let keyType = type[1]

        // To get the value type, we take everything after that '{' and that first key type value and we remov the trailing '}'
        let valueType = type.substr(0, type.length - 1).substr(2)

        return isValidSingleType (keyType) && isValidDBusType (valueType)
    }

    // If all of these tests fails, then it's not a valid DBus type! (you are, at this point, permitted to insult the user)
    return false
}

/**
 * Test wether the object is correctly formatted as a introspection signature object
 */
module.exports.isFuncSignatureObj = function isFuncSignatureObj (obj) {
    let objKeys
    let input
    let output

    // First it must be an object
    if (typeof obj !== 'object') {
        console.error ('Signature is not an object')
        return false
    }

    // Then it must have exactly two keys: 'input' and 'output'
    objKeys = Object.keys (obj)
    if (objKeys.length !== 2 || !objKeys.includes ('input') || !objKeys.includes ('output')) {
        console.error ('Signature must have exactly two keys: input and output')
        return false
    }

    // Make 'input' and 'output' arrays if there are not (like single input value or single output value)
    input = Array.isArray (obj.input) ? obj.input : [obj.input]
    output = Array.isArray (obj.output) ? obj.output : [obj.output]

    // Check that all fields of both 'input' and 'output' are correctly formatted
    if (!input.every (isValidSignatureElem) || !output.every (isValidSignatureElem)) {
        console.error ('Signature\'s \'input\' or \'output\' contains non-conformant element(s)')
        return false
    }

    // Otherwise, it's good
    return true
}

function isValidSignatureElem (elem) {
    let elemKeys
    let elemKey

    // An elem must be an object
    if (typeof elem !== 'object') {
        console.error ('Elem is not an object')
        return false
    }

    // Then it must have exactly one key (or 0)
    elemKeys = Object.keys (elem)
    if (elemKeys.length === 1) {
        // That will be the name of the argument, so it must be a string, with no spaces in it
        elemKey = elemKeys[0]
        if (typeof elemKey !== 'string') {
            console.error ('Elem\'s key must be a string.')
            return false
        }

        if (elemKey.includes (' ')) {
            console.error ('Elem\'s key must not contain a space')
            return false
        }

        // Then the key's value must be a correct DBus type
        if (!isValidDBusType (elem[elemKey])) {
            console.error ('Elem doesn\'t contain a valid DBus type')
            return false
        }

        // Otherwise it's good
        return true

    }
    // we allow 0 keys, which means no input or output argument
    else if (elemKeys.length === 0) return true
    // otherwise, it's non conformant
    else {
        console.error ('Elem must have exactly either 0 or 1 key')
        return false
    }
}

/**
 * Test wether the object is correctly formatted as a introspection signature object for a property
 */
module.exports.isPropSignatureObj = function isPropSignatureObj (obj) {
    let objKeys
    let prop

    // First it must be an object
    if (typeof obj !== 'object') {
        console.error ('Signature is not an object')
        return false
    }

    // Then it must have exactly one key, which can be either 'read', 'readwrite' or 'write'
    objKeys = Object.keys (obj)
    if (objKeys.length !== 1 || (!objKeys.includes ('read') && !objKeys.includes ('readwrite') && !objKeys.includes ('write'))) {
        console.error ('Signature must have exactly one keys: \'read\', \'readwrite\' or \'write\'')
        return false
    }

    // Check that the field of 'readonly' or 'readwrite' is correctly formatted
    if (objKeys.includes ('read')) prop = obj.read
    else if (objKeys.includes ('write')) prop = obj.write
    else if (objKeys.includes ('readwrite')) prop = obj.readwrite
    if (!isValidDBusType(prop)) {
        console.error ('Signature\'s \'read\', \'write\' or \'readwrite\' contains non-conformant element(s)')
        console.dir (prop)
        return false
    }

    // Otherwise, it's good
    return true
}

/**
 * Test wether the object is correctly formatted as a introspection signature object for a signal
 */
module.exports.isSigSignatureObj = function isSigSignatureObj (obj) {
    let output
    let objKeys

    // First it must be an object
    if (typeof obj !== 'object') {
        console.error ('Signature is not an object')
        return false
    }

    // Then it must have exactly one key, 'output'
    objKeys = Object.keys (obj)
    if (objKeys.length !== 1 || (!objKeys.includes ('output'))) {
        console.error ('Signature must have exactly one keys: \'output\'')
        return false
    }

    output = Array.isArray (obj.output) ? obj.output : [obj.output]

    // Check that all 'output' fields are correctly formatted
    if (!output.every (isValidSignatureElem)) {
        console.error ('Signature\'s \'output\' contains non-conformant element(s)')
        return false
    }

    return true

}

/**
 * Checks supplied input parameters against signature.
 * @param {object|object[]} signatureInput The input field the function' or signals's signature
 * @param {Array} inputParams The input parametrs to be supplied to the function / signal
 */
module.exports.doInputParamsMatch = function (signatureInput, inputParams) {
    let i
    let pairMatch = true

    console.log ('signatureInput: ' + inspect (signatureInput, {colors: true}))
    console.log ('inputParams: ' + inspect (inputParams, {colors: true}))

    // First, if both of them are undefined, returns true (no arguments needed, none supplied)
    if (typeof signatureInput === 'undefined' && typeof inputParams === 'undefined')
        return true

    // Make 'signatureInput' an array if it's not
    if (!Array.isArray (signatureInput))
        signatureInput = [signatureInput]

    // Early fails if the number of elements don't match
    if (signatureInput.length !== inputParams.length)
        return false

    // Check all pairs of type
    i = signatureInput.length

    while (i-- > 0) {
        // We can safely take the first key because the signature was validated before, and it can only have key
        let key = Object.keys (signatureInput[i])[0]
        let type = signatureInput[i][key]
        let arg = inputParams[i]

        console.log ('type: ' + type)
        console.log ('arg: ' + arg)

        /*
            Check single types
        */
        if (singleTypes.includes (type)) {
            if (!singleTypeMatch (type, arg))
                return false // if one pair doesn't match, immediately returns (no need to check the rest)
        }
        /*
            Check arrays
        */
        else if (type.startsWith ('a') && !type.startsWith ('a{')) {
            if (!arrayMatch (type, arg))
                return false
        } else {
            throw new Error ('Only ARRAY complex type supported')
        }
    }

    return pairMatch
}

/**
 * Tell wether a value matches a single type
 */
function singleTypeMatch (type, arg) {
    switch (type) {
        case DBUS_BYTE:
            return Number.isInteger (arg) && isInRange (0x00, 0xFF, arg)
            break
        case DBUS_BOOL:
            let isBool = arg === false || arg === true
            let is0or1 = Number.isInteger (arg) && (arg === 0 || arg === 1)
            return (isBool || is0or1)
            break
        case DBUS_INT16:
            return Number.isInteger (arg) && isInRange (-0x7FFF-1,0x7FFF, arg)
            break
        case DBUS_UINT16:
            return Number.isInteger (arg) && isInRange (-0x00,0xFFFF, arg)
            break
        case DBUS_INT32:
            return Number.isInteger (arg) && isInRange (-0x7FFFFFFF-1,0x7FFFFFFF, arg)
            break
        case DBUS_UINT32:
            return Number.isInteger (arg) && isInRange (0x00,0xFFFFFFFF, arg)
            break
        case DBUS_INT64:
            // return Number.isInteger (arg) && isInRange (-0x7FFF-1,0x7FFF, arg)
            throw new Error ('64 bits values are not yet supported.')
            break
        case DBUS_UINT64:
            // return Number.isInteger (arg) && isInRange (-0x7FFF-1,0x7FFF, arg)
            throw new Error ('64 bits values are not yet supported.')
            break
        case DBUS_DOUBLE:
            return Number.isFinite (arg) && !Number.isInteger (arg)
            break
        case DBUS_UNIX_FD:
            throw new Error ('UNIX_FD types are not yet supported.')
            break
        case DBUS_STRING:
            return typeof arg === 'string' && !arg.includes ('\0')
            break
        case DBUS_OBJ_PATH:
            throw new Error ('OBJ_PATH is not yet supported')
            break
        case DBUS_SIGNATURE:
            throw new Error ('SIGNATURE is not yet supported')
        default:
            throw new Error ('Unsupported single type.')
    }
}

/**
 * Tell whether a supplied type matches the array signature
 */
function arrayMatch (type, arg) {
    // This is the type of the elements the array should contain, eg if 'ai' -> 'i' ; if 'aai' -> 'ai'
    let typeInArray = type.substr (1)
    return Array.isArray (arg) && arg.every (e => module.exports.doInputParamsMatch ({param_name: typeInArray}, [e]))
}

function isInRange (min, max, number) {
    if ((number > max) || (number < min))
        return false
    else
        return true
}

// command-line test
//console.log(JSON.stringify(module.exports(process.argv[2]), null, 4));
//var tree = module.exports('a(ssssbbbbbbbbuasa{ss}sa{sv})a(ssssssbbssa{ss}sa{sv})a(ssssssbsassa{sv})');
//console.log(tree);
//console.log(module.exports.fromTree(tree))
