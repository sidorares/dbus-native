'use strict';

const dbus               = require ('../index.js')
const inspect            = require ('util').inspect

const DBusService       = dbus.DBusService
const DBusObjectLibs    = dbus.DBusObjectLibs
const DBusInterfaceLibs = dbus.DBusInterfaceLibs

const t = dbus.type

const DBusMethod    = DBusInterfaceLibs.DBusMethod
const DBusSignal    = DBusInterfaceLibs.DBusSignal
const DBusProperty  = DBusInterfaceLibs.DBusProperty
const DBusInterface = DBusInterfaceLibs.DBusInterface2

const DBusObject    = DBusObjectLibs.DBusObject2

// The name we want to expose our DBus service on
const serviceName   = 'com.dbus.native.basic.service'

/*
	The main interface we want to expose our methods, signals and properties.
	It's pretty common to chose a name which is the same as the service, but it is by no means mandatory.
*/
const interfaceName = serviceName

/*
	The main object path on which to expose our interface.
	Again, it's pretty common to have the path being the same as the interface and service, with dots ('.') replaced
	by slashes ('/'). But again it's not mandatory.
*/
const objectPath    = '/' + serviceName.replace (/\./g, '/')

// We expose on the session bus, which is more permissive
const sessionBus = dbus.sessionBus()

if (!sessionBus) {
	throw new Error ('Could not connect to the DBus session bus.')
}

// Create our interface
let iface = new DBusInterface (interfaceName)

/*
                _   _               _
 _ __ ___   ___| |_| |__   ___   __| |___
| '_ ` _ \ / _ \ __| '_ \ / _ \ / _` / __|
| | | | | |  __/ |_| | | | (_) | (_| \__ \
|_| |_| |_|\___|\__|_| |_|\___/ \__,_|___/
*/

// Create a function 'Capitalize' that we want to export on the bus
iface.Capitalize = function (str) {
	console.log ('Capitalized called with ' + str)

	// Here is how to return a single type (a string here)
	return str.toUpperCase()
}
/*
	Here is how to add annotate a method to expose it on the bus.
	Note that the second parameter, the name of the function, will be the exposed name on the bus, and it must be
	the same name than the function on the interface
*/
DBusMethod (iface, 'Capitalize', {
	// The keys will be the arguments's name, NO SPACE allowed.
	input: {initial_string: t.DBUS_STRING},
	output: {capitalized_string: t.DBUS_STRING}
})

// Create a function that doesn't take any input arguments
iface.SayHello = function () {
	console.log ('SayHello called')

	return 'Hello, world!'
}
DBusMethod (iface, 'SayHello', {
	input: {}, // where there is no input (or output) parameter, just assign the empty object {}
	output: {hello_sentence: t.DBUS_STRING}
})

// Create a function that takes two int32 and return their sum
iface.AddNumbers = function (n1, n2) {
	console.log ('n1 = ' + n1)
	console.log ('n2 = ' + n2)

	// throw new TypeError ('test')
	return n1 + n2
}
DBusMethod (iface, 'AddNumbers', {
	// Where there are several input parameters, make 'input' an array
	input: [
		{a: t.DBUS_INT32},
		{b: t.DBUS_INT32},
	],
	output: {sum: t.DBUS_INT32}
})

// Here is how to return a DBus STRUCT
iface.GetStruct = function() {
	// A DBus STRUCT is represented an an object whose keys are integers (in the order of the struct)
	let ret = {
		0: 'string',
		1: 33,
		2: false,
	}

	return ret
}
DBusMethod (iface, 'GetStruct', {
	input: {},
	output: {struct: t.DBUS_STRUCT (t.DBUS_STRING, t.DBUS_INT32, t.DBUS_BOOL)} // the syntaxt is straightforward
})

// Here is how to return a DBus DICT
iface.GetDict = function () {
	let m = new Map()

	m.set ('foo', 33)
	m.set ('bar', 1089)
	m.set ('foobar', 0)

	return m
}
DBusMethod (iface, 'GetDict', {
	input: {},
	output: [
		{dict: t.DBUS_DICT (t.DBUS_STRING, t.DBUS_INT16)} // First type is key, second type is value
	]
})

// Here is how to return anarray of values
iface.GetArray = function () {
	return ['foo', 'bar', 'quux']
}
DBusMethod (iface, 'GetArray', {
	input: {},
	output: {array: t.DBUS_ARRAY (t.DBUS_STRING)}
})

/*
                                 _   _
 _ __  _ __ ___  _ __   ___ _ __| |_(_) ___  ___
| '_ \| '__/ _ \| '_ \ / _ \ '__| __| |/ _ \/ __|
| |_) | | | (_) | |_) |  __/ |  | |_| |  __/\__ \
| .__/|_|  \___/| .__/ \___|_|   \__|_|\___||___/
|_|             |_|
*/

// To define a property, you just define the Javascript property...
iface.Flag = true
/*
... and "annotate" it
The key of the last object can either be:
 - 'read' for readonly access
 - 'write' for writeonly access
 - 'readwrite' for readwrite access
*/
DBusProperty (iface, 'Flag', {
	read: t.DBUS_BOOL
})

iface.StringProp = 'initial string'
DBusProperty (iface, 'StringProp', {
	readwrite: t.DBUS_STRING
})

DBusSignal (iface, 'Rand', {
	random_number: t.DBUS_INT32
})


// Create an object that implements the interface
let obj = new DBusObject (iface) // add the interface directly on build

// Note that it is also possible to add an interface with `obj.addInterface (iface)`


// Create the service
let service = new DBusService ()

// Add an child object to the service (note that the path must be relative: no initial '/')
service.addObject (obj, 'com/dbus/native/basic/service')

// Expose the service on the bus so that it's usable by other services
sessionBus.exposeService2 (service, serviceName) // the call is promisified
.then (() => {
	console.log ('Service exposed and ready to answer calls, with name \'' + serviceName + '\'')
})
.catch( (err) => {
	console.error ('Failed to exposed service on bus: ' + err)
})
