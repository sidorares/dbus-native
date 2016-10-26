'use strict';

const dbus    = require ('../../index.js')
const inspect = require ('util').inspect

const DBusInterfaceLibs = dbus.DBusInterfaceLibs

const t = dbus.type

const DBusMethod    = DBusInterfaceLibs.DBusMethod
const DBusSignal    = DBusInterfaceLibs.DBusSignal
const DBusProperty  = DBusInterfaceLibs.DBusProperty
const DBusInterface = DBusInterfaceLibs.DBusInterface2

/** @module BasicService */

/**
 * @class
 * A simple service to illustrate the various syntaxes to define DBus types
 */
class BasicService extends DBusInterface {
	constructor (...args) {
		super (...args)

		/**
		 * A simple boolean value
		 * @type {boolean}
		 */
		this.Flag = true

		/**
		 * A simple string property
		 * @type {string}
		 */
		this.StringProp = 'initial string'
	}

	/**
	 * Return the intput string, capitalized
	 * @param {sring} inputStr The string to capitalize
	 * @returns {string} The capitalized input string
	 */
	Capitalize (inputStr) {
		return inputStr.toUpperCase()
	}

	/**
	 * A simple function which shows how to define a function with no input argument (scroll down to annotations to see)
	 * @returns {string} A simple hello world string
	 */
	SayHello () {
		return 'Hello, world!'
	}

	/**
	 * Simple function which adds 2 numbers. Show how to define a function that takes multiple arguments.
	 * @param {number} a First number to add
	 * @param {number} b Second number to add
	 * @returns {number} Sum of the two numbers
	 */
	AddNumbers (a, b) {
		return a + b
	}

	/**
	 * A simple function that shows how to return a DBus STRUCT
	 * @returns {Object} The object representing the DBus structure
	 */
	GetStruct () {
		let ret = {
			0: 'string',
			1: 33,
			2: false,
		}

		console.log ('New GetStruct will return: ' + inspect (ret))

		return ret
	}

	/**
	* A simple function that shows how to return a DBus DICT
	 * @returns {TYPE HERE} The Map representing the DBus DICT
	 */
	GetDict () {
		let m = new Map()

		m.set ('foo', 33) // here is how to associate the key 'foo' with the value 33
		m.set ('bar', 1089)
		m.set ('foobar', 0)

		// To return a DBus DICT, simply return a Javascript Map
		return m
	}

	/**
	 * A simple function that shows how to return a DBus ARRAY
	 * @returns {string[]} The array representing the DBus array
	 */
	GetArray () {
		let arr =  ['foo', 'bar', 'quux']

		return arr
	}

	/**
	 * A simple function which shows how to take an array as input element (same as returning one)
	 * @param {string[]} inputArray Input array
	 * @returns {number} The number of elements inside the array
	 */
	CountElems (inputArray) {
		return arr.length
	}

	/**
	 * A simple function which shows how to take a struct as input element (same as returning one)
	 * @param {Map<string, number)} inputStruct Map representing the DBus DICT to take as input
	 * @returns {number} Number of elements inside the STRUCT
	 */
	CountKeys (inputStruct) {
		return map.size
	}

	/**
	 * A simple function which shows how to take a DICT as input element (same as returning one)
	 * @param {Object} inputStruct Object representing the DBus DICT
	 * @returns {number} Number of elements in the struct
	 */
	CountTypes (inputStruct) {
		return Object.keys(struct).filter(k => Number.isInteger (Math.floor (k))).length
	}
}

/*
 __  __      _   _               _
|  \/  | ___| |_| |__   ___   __| |___
| |\/| |/ _ \ __| '_ \ / _ \ / _` / __|
| |  | |  __/ |_| | | | (_) | (_| \__ \
|_|  |_|\___|\__|_| |_|\___/ \__,_|___/
*/

DBusMethod (BasicService, 'Capitalize', {
	input: [
		{input_str: t.DBUS_STRING},
	],
	output: [
		{capitalized_str: t.DBUS_STRING},
	],
})

DBusMethod (BasicService, 'SayHello', {
	input: [
	],
	output: [
		{hello_sentence: t.DBUS_STRING},
	],
})

DBusMethod (BasicService, 'AddNumbers', {
	input: [
		{a: t.DBUS_INT32},
		{b: t.DBUS_INT32},
	],
	output: [
		{sum: t.DBUS_INT32},
	],
})

DBusMethod (BasicService, 'GetStruct', {
	input: [
	],
	output: [
		{struct: t.DBUS_STRUCT (t.DBUS_STRING, t.DBUS_INT32, t.DBUS_BOOL)},
	],
})

DBusMethod (BasicService, 'GetDict', {
	input: [
	],
	output: [
		{dict: t.DBUS_DICT (t.DBUS_STRING, t.DBUS_INT16)},
	],
})

DBusMethod (BasicService, 'GetArray', {
	input: [
	],
	output: [
		{array: t.DBUS_ARRAY (t.DBUS_STRING)},
	],
})

DBusMethod (BasicService, 'CountElems', {
	input: [
		{input_array: t.DBUS_ARRAY (t.DBUS_STRING)},
	],
	output: [
		{nb_elems: t.DBUS_UINT16},
	],
})

DBusMethod (BasicService, 'CountKeys', {
	input: [
		{input_struct: t.DBUS_DICT (t.DBUS_STRING, t.DBUS_INT16)},
	],
	output: [
		{nb_keys: t.DBUS_UINT16},
	],
})

DBusMethod (BasicService, 'CountTypes', {
	input: [
		{input_struct: t.DBUS_STRUCT (t.DBUS_STRING, t.DBUS_INT32, t.DBUS_BOOL)},
	],
	output: [
		{nb_types: t.DBUS_UINT32},
	],
})

/*
 ____                            _   _
|  _ \ _ __ ___  _ __   ___ _ __| |_(_) ___  ___
| |_) | '__/ _ \| '_ \ / _ \ '__| __| |/ _ \/ __|
|  __/| | | (_) | |_) |  __/ |  | |_| |  __/\__ \
|_|   |_|  \___/| .__/ \___|_|   \__|_|\___||___/
                |_|
*/

DBusProperty (BasicService, 'Flag', {
	read: t.DBUS_BOOL
})

DBusProperty (BasicService, 'StringProp', {
	readwrite: t.DBUS_STRING
})

/*
 ____  _                   _
/ ___|(_) __ _ _ __   __ _| |___
\___ \| |/ _` | '_ \ / _` | / __|
 ___) | | (_| | | | | (_| | \__ \
|____/|_|\__, |_| |_|\__,_|_|___/
         |___/
*/

DBusSignal (BasicService, 'Rand', {
	output: [
		{random_number: t.DBUS_INT32},
	],
})

DBusSignal (BasicService, 'TestSig', {
	output: [
		{sig_param: t.DBUS_STRUCT (t.DBUS_STRING, t.DBUS_BOOL)},
	],
})

module.exports = BasicService

// DBus service class generated with DBusGenesis!
