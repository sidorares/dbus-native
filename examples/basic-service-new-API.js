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

/*
	This file's purpose is to demonstrate how to use the new API to define a simple DBus service.
	Note that this file is rather big because it is very much commented and each line is explained.
	We define a number of functions that do nothing very interesting, but they show how to use almost all DBus types.
*/

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

/*
	We create our interface.
	In the new API, an interface is the object that has the methods, properteis and signals that can be called, get/set
	or emitted.
*/
let iface = new DBusInterface (interfaceName)

/*
                _   _               _
 _ __ ___   ___| |_| |__   ___   __| |___
| '_ ` _ \ / _ \ __| '_ \ / _ \ / _` / __|
| | | | | |  __/ |_| | | | (_) | (_| \__ \
|_| |_| |_|\___|\__|_| |_|\___/ \__,_|___/
*/

/*
	Here is the part where we define methods.
	Defining a method for DBus is done in two steps:
	1) define a (Javascript) method in the interface object. This is a normal Javascript method. Is synchronous, you can
	   simply return the value(s). In case of error, throw a (real) Javascript Error.
	   If asynchronous, use and return a promise, in case of failing, throw a (real) Javascript error.
	2) "annotate" the function (this step is required because DBus needs to know the function's argument's types.). This
	   step is boilerplate (because we need to manaully specify some code, and in theory, nothing prevents us from
       annotating with types that do not correspond to the function's definition) but we have no other choice as
	   Javascript is not typed at all and DBus is strongly typed.
*/

// Create a function 'Capitalize' that we want to export on the bus: this is a normal Javascript function
iface.Capitalize = function (str) {
	console.log ('Capitalized called with ' + str)

	// Here is how to return a single type (a string here): it's just returning the value, as usual
	return str.toUpperCase()
}
/*
	Here is how to add annotate a method to expose it on the bus.
	Note that the second parameter, the name of the function, will be the exposed name on the bus, and it must be
	the same name than the function on the interface
*/
DBusMethod (iface, 'Capitalize', {
	/*
		The keys will be the arguments's name, NO SPACE allowed.
		When there are only one argument (like here for 'input' and for 'output'), we can define a single object.
		But when there are several, 'input' nad?or 'output' should be an array of those object (see below)
	*/
	input: {initial_string: t.DBUS_STRING},
	output: {capitalized_string: t.DBUS_STRING}
})

// Create a function that doesn't take any input arguments
iface.SayHello = function () {
	console.log ('SayHello called')

	return 'Hello, world!' // return a string
}
DBusMethod (iface, 'SayHello', {
	input: {}, // where there is no input (or output) parameter, just assign the empty object {}
	output: {hello_sentence: t.DBUS_STRING}
})

// Create a function that takes two int32 and return their sum
iface.AddNumbers = function (n1, n2) {
	console.log ('n1 = ' + n1)
	console.log ('n2 = ' + n2)

	// as usual, returning a single, non-container type is straightforward.
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

/*
	This function is here to illustrate how to use DBus STRUCT types.
*/
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
	/*
		The syntax is pretty straightforward: for all DBus container types (i.e. ARRAY, DICT and STRUCT), the annotation
		is a function, which takes the contained values' types.
		For a structure, they are the types of the elements, in the order in which they appear in the struct
	*/
	output: {struct: t.DBUS_STRUCT (t.DBUS_STRING, t.DBUS_INT32, t.DBUS_BOOL)}
})

/*
	This function is here to illustrate how to use DBus DICT types.
*/
iface.GetDict = function () {
	/*
		As you can see, a DBus DICT matches really well with Javascript's Map.
		The keys must be of the first type specified in the signature, and the values of the second type.
		This is pretty straightforward.
	*/
	let m = new Map()

	m.set ('foo', 33) // here is how to associate the key 'foo' with the value 33
	m.set ('bar', 1089)
	m.set ('foobar', 0)

	// To return a DBus DICT, simply return a Javascript Map
	return m
}
DBusMethod (iface, 'GetDict', {
	input: {},
	/*
		To annotate a DBus DICT, this is easy, the first type is the type of the keys, and the second is the value's
	*/
	output: [
		{dict: t.DBUS_DICT (t.DBUS_STRING, t.DBUS_INT16)}
	]
})

/*
	This function is here to illustrate how to use DBus ARRAY types.
*/
iface.GetArray = function () {
	// A DBus array matches is represented very simply by a Javascript array
	return ['foo', 'bar', 'quux']
}
DBusMethod (iface, 'GetArray', {
	input: {},
	// To annotate an array, simple use DBUS_ARRAY() with one argument: the type of the array's elements
	output: {array: t.DBUS_ARRAY (t.DBUS_STRING)}
})

/*
	As of now, we have presented the major DBus types supported by dbus-native.
	But most of them were supported through return type (i.e. functions returned these types)
	The following functions just demontrate that, of course, it's possible to pass those types as arguments (everything
    is exactly the same, but the types are in the 'input' field now)
*/

/*
	This is a function that takes an array in input (and return the number of items inside)
*/
iface.CountElems = (arr) => {
	return arr.length
}
DBusMethod (iface, 'CountElems', {
	input: [
		{input_array: t.DBUS_ARRAY (t.DBUS_STRING)} // as said before: this is exactly like for output values
	],
	output: [
		{nb_elems: t.DBUS_UINT16}
	]
})

/*
	This function is similar to the previous one: only it takes DICT (which is a Map in Javascript) and returns the
	number of elements inside.
*/
iface.CountKeys = (map) => {
	console.log ('CountKeys received:\n' + inspect (map))
	return map.size
}
DBusMethod (iface, 'CountKeys', {
	input: [
		{input_struct: t.DBUS_DICT (t.DBUS_STRING, t.DBUS_INT16)}
	],
	output: [
		{nb_keys: t.DBUS_UINT16}
	]
})

/*
	Again, same kind of functions, but it takes a STRUCT,, it also counts the number of types inside.
*/
iface.CountTypes = (struct) => {
	console.log ('CountTypes received: ' + inspect (struct))
	return Object.keys(struct).filter(k => Number.isInteger (Math.floor (k))).length
}
DBusMethod (iface, 'CountTypes', {
	input: {input_struct: t.DBUS_STRUCT (t.DBUS_STRING, t.DBUS_INT32, t.DBUS_BOOL)},
	output: {nb_types: t.DBUS_UINT32}
})

/*
	Now that you have seen alsmot all of what's possible, don't hesitate to experiment and mix the types
*/

/*
                                 _   _
 _ __  _ __ ___  _ __   ___ _ __| |_(_) ___  ___
| '_ \| '__/ _ \| '_ \ / _ \ '__| __| |/ _ \/ __|
| |_) | | | (_) | |_) |  __/ |  | |_| |  __/\__ \
| .__/|_|  \___/| .__/ \___|_|   \__|_|\___||___/
|_|             |_|
*/

/*
	The following sectios shows how to define DBus properties.
	This follows the same spirit as for functions (methods).
	A DBus property is simply a Javascriptn property on the interface object.
	1) define the property by standard Javascript assignment
	2) "annotate" the property to tell DBus its type and so that the binding can make a getter/setter out of this
	   property.
	   The access mode is driven by the name of the key in the object passed to the annotation function (see example)
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
	read: t.DBUS_BOOL // readonly access
})

// This illustrates how to define a string property
iface.StringProp = 'initial string'
DBusProperty (iface, 'StringProp', {
	readwrite: t.DBUS_STRING // readwrite access
})

/*
     _                   _
 ___(_) __ _ _ __   __ _| |___
/ __| |/ _` | '_ \ / _` | / __|
\__ \ | (_| | | | | (_| | \__ \
|___/_|\__, |_| |_|\__,_|_|___/
       |___/
*/

/*
	The following sections shows how to define signals.
	Again, it follows the same logic. It is exactly like defining methods, but there should only be an 'output' field.
	Note that since interfaces are EventEmitter, there is no need to 'register' an event to it beforehand,
	So the only necessary step is to "annotate" the signal, for DBus to know the types.
	Then when it's time to emit the signal, simply use `iface.emit('<signal-name>', <signal-arg-1>, <signal-arg-2>, etc.)`
*/

/*
	This defines a signal named 'Rand' which has one argument: an int32
*/
DBusSignal (iface, 'Rand', {
	output: [
		{random_number: t.DBUS_INT32},
	],
})

/*
	This defines a signal 'TestSig' which emits a STRUCT
*/
DBusSignal (iface, 'TestSig', {
	output: [
		{sig_param: t.DBUS_STRUCT (t.DBUS_STRING, t.DBUS_BOOL)}
		// {string_arg: t.DBUS_STRING},
		// {bool_arg: t.DBUS_BOOL}
	],
})

/*
	Here we use an interval with randomness so that the signals are not fired too regularly.
	Of course, in real applications, emit signals wherever you want.
*/
setInterval( () => {
	let rand = Math.round (100 * Math.random())

	if (rand >= 50) {
		let nb = Math.round (100 * Math.random())
		console.log ('[EMIT RAND] ' + nb)

		/*
			This is how to really emit the 'Rang' signal: it is emitted EXACTLY like a Javascript's EventEmitter signal
			Simply pass the argument(s) after the name.
			It is REALLY easy and comes naturally.
		*/
		iface.emit ('Rand', nb)
	}
}
, 2000)

/*
	Same remark for the randomness.
	Here we emit the 'TestSig' with a slightly more complex type: a STRUCT (object with integer keys)
*/
setInterval( () => {
	let rand = Math.round (100 * Math.random())

	if (rand >= 50) {
		console.log ('[EMIT TESTSIG] ')

		// Emitting is simply emitting the EventEmitter signals
		iface.emit ('TestSig', {
			0: 'hello, world!',
			1: false
		})
	}
}
, 2500)

/*
	Now you have finished defining your interface's methods, properties and signals.
	It's time to wrap up everything in the desired object path, create the DBusService object and expose it on the bus.
*/

/*
	Create an object that implements the interface
	You can have several object that implement the same interface: this is the strengh of this approach.
*/
let obj = new DBusObject (iface) // add the interface directly on build

// Note that it is also possible to add an interface with `obj.addInterface (iface)` It's really up to you


/*
	Create the service
	A service has several objects and each of these object have interfaces
*/
let service = new DBusService ()

/*
	Add an child object to the service (note that the path must be relative: no initial '/')
	Note that, similarly to object and interfaces, you could directly pass the obj and the relative path to the
	service's constructor, as such: `let service = new DBusService (obj, 'com/dbus/native/basic/service')`
*/
service.addObject (obj, 'com/dbus/native/basic/service')

/*
	Expose the service on the bus so that it's usable by other services
	It's at _this moment_ that the service becomes available on the bus.
*/
sessionBus.exposeService2 (service, serviceName) // the call is promisified
.then (() => {
	// In the '.then()', it means the servie is correclty exposed on the bus
	console.log ('Service exposed and ready to answer calls, with name \'' + serviceName + '\'')
})
.catch( (err) => {
	// In the `.catch()`, it means there was a problem while trying to expose the service on the bus
	console.error ('Failed to exposed service on bus: ' + err)
})
