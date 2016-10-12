const inspect        = require ('util').inspect
const parseSignature = require('./signature.js');

/** @module DBuffer */

/**
 * Custom type to hold a Buffer and keep track of what's been consummed so far (with the help of 'pos')
 */
function DBusBuffer(buffer, startPos, options)
{
	this.options = options || { ayBuffer: true };
	this.buffer = buffer;
	this.startPos = startPos ? startPos : 0,
	this.pos = 0;
}

/**
 * Take care of aligning the Buffer to the correct position
 * @todo still working on the <em>exact</em> meaning of this.
 */
DBusBuffer.prototype.align = function(power) {
	// console.log ('-------')
	// console.log ('align(' + power + ')')
	var allbits = (1<<power) - 1;
	// console.log ('allbits: ' + allbits)
	var paddedOffset = ((this.pos + this.startPos + allbits) >> power) << power;
	// console.log ('paddedOffset: ' + paddedOffset)
	// console.log ('this.pos (before): ' + this.pos)
	this.pos = paddedOffset - this.startPos;
	// console.log ('this.pos (after): ' + this.pos)
	// console.log ('-------')
}

/*
 ____  _                 _        _____
/ ___|(_)_ __ ___  _ __ | | ___  |_   _|   _ _ __   ___  ___
\___ \| | '_ ` _ \| '_ \| |/ _ \   | || | | | '_ \ / _ \/ __|
 ___) | | | | | | | |_) | |  __/   | || |_| | |_) |  __/\__ \
|____/|_|_| |_| |_| .__/|_|\___|   |_| \__, | .__/ \___||___/
                  |_|                  |___/|_|
*/

/**
 * Read an 8-bit integer, consumes 1 byte.
 */
DBusBuffer.prototype.readInt8 = function() {
	this.pos++;
	return this.buffer[this.pos - 1];
}

/**
 * Read a 16-bit, signed integer, consummes 2 bytes
 */
DBusBuffer.prototype.readSInt16 = function() {
	this.align(1);
	var res = this.buffer.readInt16LE(this.pos);
	this.pos += 2;
	return res;
}

/**
 * Read a 16-bit, unsigned integer, consummes 2 bytes
 */
DBusBuffer.prototype.readInt16 = function() {
	this.align(1);
	var res = this.buffer.readUInt16LE(this.pos);
	this.pos += 2;
	return res;
}

/**
 * Read a 32-bit, signed integer, consummes 4 bytes
 */
DBusBuffer.prototype.readSInt32 = function() {
	this.align(2);
	var res = this.buffer.readInt32LE(this.pos);
	this.pos += 4;
	return res;
}

/**
 * Read a 32-bit, unsigned integer, consummes 4 bytes
 */
DBusBuffer.prototype.readInt32 = function() {
	this.align(2);
	var res = this.buffer.readUInt32LE(this.pos);
	this.pos += 4;
	return res;
}

/**
 * Read a 64-bit double, consummes 8 bytes
 */
DBusBuffer.prototype.readDouble = function() {
	this.align(3);
	var res = this.buffer.readDoubleLE(this.pos);
	this.pos += 8;
	return res;
}

/**
 * Read a string. Consumes N + 1 bytes, where N is the length of the string, the additional byte is for the NUL byte
 * @param {number} len - Length of the string to read (not including the terminating NUL byte)
 */
DBusBuffer.prototype.readString = function(len) {
	if (len === 0) {
		this.pos++;
		return '';
	}
	var res = this.buffer.toString('utf8', this.pos, this.pos + len);
	this.pos += len + 1; // dbus strings are always zero-terminated ('s' and 'g' types)
	return res;
}

/*
  ____            _        _                   _____
 / ___|___  _ __ | |_ __ _(_)_ __   ___ _ __  |_   _|   _ _ __   ___  ___
| |   / _ \| '_ \| __/ _` | | '_ \ / _ \ '__|   | || | | | '_ \ / _ \/ __|
| |__| (_) | | | | || (_| | | | | |  __/ |      | || |_| | |_) |  __/\__ \
 \____\___/|_| |_|\__\__,_|_|_| |_|\___|_|      |_| \__, | .__/ \___||___/
                                                    |___/|_|
*/

/**
 * Read data from a complex (container) structure, passed as argument.<br>
 * Byte consumption depends on what's being read.
 */
DBusBuffer.prototype.readTree = function readTree(tree) {
	switch (tree.type) {
		case '(':
		case '{':
		case 'r':
			// STRUCT and DICT entries are always aligned to 8-byte boundaries, regardless of their actual content
			this.align(3);
			let ret = this.readStruct(tree.child)
			console.log (inspect (ret, {colors: true, depth: 5}))
			return ret
			// return this.readStruct(tree.child);
		case 'a':
			if (!tree.child || tree.child.length != 1)
				throw new Error('Incorrect array element signature');

			var arrayBlobLength = this.readInt32(); // The length of an array is always encoded as a 32-bit unsigned integer
			return this.readArray(tree.child[0], arrayBlobLength);
		case 'v':
			return this.readVariant();
		default:
			return this.readSimpleType(tree.type);
	}
}

/**
 * Read values from the buffer according to the signature passed.
 * @param {string} signature - The DBus-formatted signature that drives what should be read & extracted from the buffer
 */
DBusBuffer.prototype.read = function read(signature) {
	// console.log ('[READ]')
	// console.log ('signature: ' + inspect (signature, {colors: true}))

	// First, we parse the signature into a structured tree
	var tree = parseSignature(signature);

	// console.log ('Tree parsed from the signature: ' + inspect (tree, {colors: true, depth: 5}))

	// Then we used 'readStruct' on this formatted tree to extract the data
	return this.readStruct(tree);
}

/**
 * Read a variant value from the buffer.<br>
 * A variant type is encoded as such: first the the signature representing the actual type is written,<br>
 * then the actual type is written.<br>
 * So here we first read the signature (which is a singletype 'g') and then, we build a tree from this signature
 * (parsing, really) and read the correct type.
 */
DBusBuffer.prototype.readVariant = function readVariant() {
	var signature = this.readSimpleType('g');
	//if (isSimpleType[signature])
	//  return this.readSimpleType(signature);

	//if (signature == 'a{sv}')
	//{
	//  var arrayBlobLength = this.readInt32();
	//  return this.readArray(parseSignature(signatur
	//}
	var tree = parseSignature(signature);
	return [tree, this.readStruct(tree)];
}

/**
 * Read the buffer based on the complex, deep tree it is passed as an argument.
 */
DBusBuffer.prototype.readStruct = function readStruct(struct) {
/* NEW API
    let obj = {}

    for (let i = 0; i < struct.length; i++)
        // A struct in Javascript is represented as an object with integers keys
        obj[i] = this.readTree (struct[i])

    return obj
//*/
//* OLD API
  var result = [];
  for (var i = 0; i < struct.length; ++i) {
    result.push(this.readTree(struct[i]));
  }
  return result;
//*/
}

/**
 * Read an array of element from the buffer.
 * @param {string} eleType       The type of elements in the array (array are uniforms)
 * @param {number} arrayBlobSize The number of elements to read
 */
DBusBuffer.prototype.readArray = function readArray(eleType, arrayBlobSize) {
	var result = []
	var key, value;
	var start = this.pos;

	/*
	if (isHash(eleType)) {
	result = {};
	while(this.pos < start + arrayBlobSize) {
	  this.align(3);
	  key = this.readTree(eleType.child[0]);
	  result[key] = this.readTree(eleType.child[1]);
	}
	console.log('Hash!!!', eleType, parseSignature.fromTree(eleType), result);
	return result;
	}
	*/

	// special case: treat ay as Buffer
	if (eleType.type === 'y' && this.options.ayBuffer) {
		this.pos += arrayBlobSize;
		// When ay is treated as buffer, we simply return the slice of the buffer that corresponds
		return this.buffer.slice(start, this.pos);
	}

	// end of array is start of first element + array size
	// we need to add 4 bytes if not on 8-byte boundary
	// and array element needs 8 byte alignment
	if (['x', 't', 'd', '{', '(', 'r'].indexOf(eleType.type) != -1)
		this.align(3);

	var end = this.pos + arrayBlobSize;

	while(this.pos < end)
		result.push(this.readTree(eleType));

	return result;
}

/*
	Read a simple (i.e. non container) type from the buffer
*/
DBusBuffer.prototype.readSimpleType = function readSimpleType(t) {
	switch (t) {
		case 'y':
			return this.readInt8();
		case 'b':
			// TODO: spec says that true is strictly 1 and false is strictly 0
			// shold we error (or warn?) when non 01 values?
			return this.readInt32() ? true : false;
		case 'n':
			return this.readSInt16();
		case 'q':
			return this.readInt16();
		case 'u':
			return this.readInt32();
		case 'i':
			return this.readSInt32();
		case 'g':
			/*
				In case of signatures (which is a string), the length of the string representing the signature
				is first encoded in a 8-bit (1-byte) integer.
				So we first read this 1-byte integer, the length, and then a 'len'-long string from there.
			*/
			var len = this.readInt8();
			return this.readString(len);
		case 's':
		case 'o':
			var len = this.readInt32();
			return this.readString(len);
			// TODO: validate object path here
			//if (t === 'o' && !isValidObjectPath(str))
			//  throw new Error('string is not a valid object path'));
		case 'x': //signed
			this.align(3);
			// TODO: BE 0x100000000*this.readInt32() + this.readInt32();
			// TODO: use bn.js
			return this.readInt32() + 0x100000000*this.readInt32();
		case 't': //unsigned
			this.align(3);
			var word0 = this.readInt32();
			var word1 = this.readInt32();
			if (!(word1 & 0x80000000))
			return word0 + 0x100000000*word1;
			// return -((((~word1)>>>0) * 0x100000000) + ((~word0)>>>0) + 1); // ???
		case 'd':
			return this.readDouble();
		default:
			throw new Error('Unsupported type: ' + t);
	}
//	return result;// ???
}

module.exports = DBusBuffer;
