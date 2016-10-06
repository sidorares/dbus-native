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

module.exports.DBUS_BYTE      = 'y'
module.exports.DBUS_BOOL      = 'b'
module.exports.DBUS_INT16     = 'n'
module.exports.DBUS_UINT16    = 'q'
module.exports.DBUS_INT32     = 'i'
module.exports.DBUS_UINT32    = 'u'
module.exports.DBUS_INT64     = 'x'
module.exports.DBUS_UINT64    = 't'
module.exports.DBUS_DOUBLE    = 'd'
module.exports.DBUS_UNIX_FD   = 'h'
module.exports.DBUS_STRING    = 's'
module.exports.DBUS_OBJ_PATH  = 'o'
module.exports.DBUS_SIGNATURE = 'g'

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

function isValidDBusType (type) {
    // Check if 'type' is a single type (or several single types)
    if (isValidSingleType (type)) return true

    if (type.split('').every(isValidSingleType)) return true

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

    // If all of these tests fails, then it's not a valid DBus type! (you are, at this point, permitted to unsult the user)
    return false
}

// command-line test
//console.log(JSON.stringify(module.exports(process.argv[2]), null, 4));
//var tree = module.exports('a(ssssbbbbbbbbuasa{ss}sa{sv})a(ssssssbbssa{ss}sa{sv})a(ssssssbsassa{sv})');
//console.log(tree);
//console.log(module.exports.fromTree(tree))
