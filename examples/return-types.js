'use strict';

const dbus = require ('../index.js')

/*
	This test file's purpose is to show example of possible return types for functions.
	In order to do that, we connect to the session bus and create a DBus service exposing
	a certain number of function calls (no signals nor properties) that you can call with
	any DBus-speaking software.

	For instance you can use `gdbus` to introspect a service and make function calls.
	- introspect: `gdbus introspect -e -d com.dbus.native.return.types -o /com/dbus/native/return/types`
	- make a method call: `gdbus introspect -e -d com.dbus.native.return.types -o /com/dbus/native/return/types -m com.dbus.native.return.types.FunctionName`
*/

const serviceName   = 'com.dbus.native.return.types' // our DBus service name
/*
	The interface under which we will expose our functions (chose to be the same as the service name, but we can
	choose whatever name we want, provided it respects the rules, see DBus naming documentation)
*/
const interfaceName = serviceName
/*
	The object pat hthat we want to expose on the bus. Here we chose to have the same path as the service (and
	interface) name, with the dots replaced by slashes (because objects path must be on the form of UNIX paths)
	But again, we could chose anything. This is just a demo here.
*/
const objectPath    = '/' + serviceName.replace (/\./g, '/')

// First, connect to the session bus (works the same on the system bus, it's just less permissive)
const sessionBus = dbus.sessionBus()

// Check the connection was successful
if (!sessionBus) {
	throw new Error ('Could not connect to the DBus session bus.')
}

/*
	Then request our service name to the bus.
	The 0x4 flag means that we don't want to be queued if the service name we are requesting is already
	owned by another service ;we want to fail instead.
*/
sessionBus.requestName (serviceName, 0x4, (e, retCode) => {
	// If there was an error, warn user and fail
	if (e) {
		throw new Error (`Could not request service name ${serviceName}, the error was: ${e}.`)
	}

	// Return code 0x1 means we successfully had the name
	if (retCode === 1) {
		console.log (`Successfully requested service name "${serviceName}"!`)
		proceed()
	}
	/* Other return codes means various errors, check here
	(https://dbus.freedesktop.org/doc/api/html/group__DBusShared.html#ga37a9bc7c6eb11d212bf8d5e5ff3b50f9) for more
	information
	*/
	else {
		throw new Error (`Failed to request service name "${serviceName}". Check what return code "${retCode}" means.`)
	}
})

// Function called when we have successfully got the service name we wanted
function proceed() {
	let ifaceDesc
	let iface

	// First, we need to create our interface description (here we will only expose method calls)
	ifaceDesc = {
		name: interfaceName,
		methods: {
			SayHello: ['', 's', [], ['hello_sentence']], // Takes no input and returns a single string
			GetInt16: ['', 'n', [], ['Int16_number']], // Takes no input and returns an int16 integers
			GetUInt16: ['', 'q', [], ['UInt16_number']], // Takes no input and returns an uint16 integers
			GetInt32: ['', 'i', [], ['Int32_number']], // Takes no input, returns an int32 integer
			GetUInt32: ['', 'u', [], ['UInt32_number']], // Takes no input, returns an uint32 integer
			// 64 numbers being not handled natively in Javascript, they are not yet handled by this library (WIP)
			//GetInt64: ['', 'x', [], ['Int32_number']], // Takes no input, returns an int64 integer
			//GetUInt64: ['', 't', [], ['UInt32_number']], // Takes no input, returns an uint64 integer
			GetBool: ['', 'b', [], ['Bool_value']], // Takes no input, returns a boolean
			GetDouble: ['', 'd', [], ['Double_value']], // Takes no input, returns a double
			GetByte: ['', 'y', [], ['Byte_value']], // Takes no input, returns a byte
		},
		// No signals nor properties for this example
		signals: {},
		properties: {}
	}

	// Then we need to create the interface implementation (with actual functions)
	iface = {
		SayHello: function() {
			return 'Hello, world!' // This is how to return a single string
		},
		GetInt16: function() {
			let min = -0x7FFF-1
			let max = 0x7FFF
			return Math.round (Math.random() * (max - min) + min)
		},
		GetUInt16: function() {
			let min = 0
			let max = 0xFFFF
			return Math.round (Math.random() * (max - min) + min)
		},
		GetInt32: function() {
			let min = -0x7FFFFFFF-1
			let max = 0x7FFFFFFF
			return Math.round (Math.random() * (max - min) + min)
		},
		GetUInt32: function() {
			let min = 0
			let max = 0xFFFFFFFF
			return Math.round (Math.random() * (max - min) + min)
		},
		GetBool: function() {
			return Math.random() >= 0.5 ? true : false
		},
		GetDouble: function() {
			/*
				We are only returning a number between 0 and 1 here, but this is just for the test.
				Javascript can handle number between Number.MIN_VALUE and Number.MAX_VALUE, which are 5e-234 and 1.7976931348623157e+308 respectively.
				There would be no point in returing such big numbers for this demo, but this is perfectly okay with DBus.
			*/
			return Math.random()
		},
		GetByte: function() {
			let min = 0x00
			let max = 0xFF
			return Math.round (Math.random() * (max - min) + min)
		}
	}

	// Now we need to actually export our interface on our object
	sessionBus.exportInterface (iface, objectPath, ifaceDesc)

	// Say our service is ready to receive function calls (you can use `gdbus call` to make function calls)
	console.log ('Interface exposed to DBus, ready to receive function calls!')
}
