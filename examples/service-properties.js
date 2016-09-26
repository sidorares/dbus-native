'use strict';

const dbus = require ('../index.js')

/*
	This example file's purpose is to show how to get and set DBus properties.
	In order to do that, we connect to the session bus and create a DBus service exposing
	a certain number of properties (no methods nor signals) that you can call with
	any DBus-speaking software.

	For instance you can use `gdbus` to get and set properties:
	- get: `gdbus call -e -d com.dbus.native.properties -o /com/dbus/native/properties -m org.freedesktop.DBus.Properties.Get 'com.dbus.native.properties' '<PropertyName>'
	- set: `gdbus call -e -d com.dbus.native.properties -o /com/dbus/native/properties -m org.freedesktop.DBus.Properties.Set 'com.dbus.native.properties' '<PropertyName>' '<PropertyValue>'
*/

const serviceName   = 'com.dbus.native.properties' // our DBus service name
/*
	The interface under which we will expose our functions (chose to be the same as the service name, but we can
	choose whatever name we want, provided it respects the rules, see DBus naming documentation)
*/
const interfaceName = serviceName
/*
	The object path that we want to expose on the bus. Here we chose to have the same path as the service (and
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
		// No methods nor signals for this example
		methods: {},
		signals: {},
		properties: {
			// Single types
			SingleString: 's',
			SingleInt32: 'i',
			SingleBool: 'b',

			// Arrays
			ArrayOfStrings: 'as',
			ArrayOfUint16: 'aq',
			// Nested arrays!
			ArrayOfArrayOfInt32: 'aai',

			// Structs
			Structiii: '(iii)',
			Structsb: '(sb)',
			Structsai: '(sai)', // struct who first item is a string (s) and the second is an array of int32 (ai)

			// Dict entries, note that dict entries are ALWAYS array of dict entries
			Dictsi: 'a{si}',
			Dictsb: 'a{sb}',
		}
	}

	// Then we need to create the interface implementation (with actual values)
	iface = {
		// Single types
		SingleString: 'Hello, world!',
		SingleInt32: 1089,
		SingleBool: true,

		/*
        	_
           / \   _ __ _ __ __ _ _   _ ___
          / _ \ | '__| '__/ _` | | | / __|
         / ___ \| |  | | | (_| | |_| \__ \
        /_/   \_\_|  |_|  \__,_|\__, |___/
                                |___/
		*/
		/*
			Note the double brackets, here is how it works:
			- First (outer) pair of brackets means "complex / container type"
			- Second (inner) pair of brackets is the _array_
		*/
		ArrayOfStrings: [['Array', 'of', 'Strings']],
		ArrayOfUint16: [[10, 100, 1000]],
		// Nested array@
		/*
			Note the triple brackets, works the same as before:
			- First (outer) brackets means "complex / container type"
			- Second brackets is the 'Array' (of something)
			- Third is the 'Array of Int32'
		*/
		ArrayOfArrayOfInt32: [[[1,2], [3,4,5], [6,7]]],

		/*
         ____  _                   _
        / ___|| |_ _ __ _   _  ___| |_ ___
        \___ \| __| '__| | | |/ __| __/ __|
         ___) | |_| |  | |_| | (__| |_\__ \
        |____/ \__|_|   \__,_|\___|\__|___/


		*/
		/*
			Note the double brackets:
			- First (outer) brackets means "complex / container" type
			- Second (inner) brackets is how we represent the DBus "struct" type: it's an array whose elements are in
			the same order as the elements in the DBus struct
		*/
		Structiii: [[1000, 2000, 3000]],
		Structsb: [['string', false]],
		/*
			Note the triple brackets, works the same as before:
			- First (outer) brackets means "complex / container type"
			- Second (inner) brackets is the way we represent a struct in JS
			- Then comes the first param, the string, and the third pair of brackets is the actual array of int32
		*/
		Structsai: [['other string', [33, 1089]]],

		/*
         ____  _      _
        |  _ \(_) ___| |_ ___
        | | | | |/ __| __/ __|
        | |_| | | (__| |_\__ \
        |____/|_|\___|\__|___/

		*/
		/*
			Note the triple brackets, again, same as before:
			- First (outer) means "complex / container type"
			- Second is the array (remember dict entries are always, in fact, arrays of dict entries), see Dictsb for an
			  exanple with actual several dict entries
			- Third (inner) is how we represent a dict entry in Javascript: it's an array whose first value is the key,
			  and the second is the value
		*/
		Dictsi: [[['age', 33]]],
		Dictsb: [[['isAwesome', true], ['amOwner', false]]],

	}

	/*
		For the lazy who don't want to actually start the service and type the `gdbus introspect` command, here is the
		output you'd have (note: since this is for the lazy, I don't garantee that it's going to be up-to-date with
		the example below, in doubt, don't be lazy and type the goddamn command!)

		interface com.dbus.native.properties {
    methods:
    signals:
    properties:
      readwrite s SingleString = 'Hello, world!';
      readwrite i SingleInt32 = 1089;
      readwrite b SingleBool = true;
      readwrite as ArrayOfStrings = ['Array', 'of', 'Strings'];
      readwrite aq ArrayOfUint16 = [10, 100, 1000];
      readwrite aai ArrayOfArrayOfInt32 = [[1, 2], [3, 4, 5], [6, 7]];
      readwrite (iii) Structiii = (1000, 2000, 3000);
      readwrite (sb) Structsb = ('string', false);
      readwrite (sai) Structsai = ('other string', [33, 1089]);
      readwrite a{si} Dictsi = {'age': 33};
      readwrite a{sb} Dictsb = {'isAwesome': true, 'amOwner': false};
  };

	*/

	// Now we need to actually export our interface on our object
	sessionBus.exportInterface (iface, objectPath, ifaceDesc)

	// Say our service is ready to receive function calls (you can use `gdbus call` to make function calls)
	console.log ('Interface exposed to DBus, ready to receive function calls!')
}
