'use strict';

const dbus    = require ('../../index.js')
const inspect = require ('util').inspect
const Promise = require ('bluebird')

const DBusInterfaceLibs = dbus.DBusInterfaceLibs

const t = dbus.type

const DBusMethod    = DBusInterfaceLibs.DBusMethod
const DBusSignal    = DBusInterfaceLibs.DBusSignal
const DBusProperty  = DBusInterfaceLibs.DBusProperty
const DBusInterface = DBusInterfaceLibs.DBusInterface

/** @module SimpleService */

/**
 * @class
 * Very simple class that is intended to be the first example people see of how to use the dbus-native library.
 * It provides with minimal code, syntax and one example of each: a method, a property and a signal.
 */
class SimpleService extends DBusInterface {
	constructor (...args) {
		super (...args)

		/*
			Here we define our service's properties. They are defined as normal, Javascript properties.
			Note that we can also define properties here that WILL NOT be exposed as a DBus property; only properties
			that are annotated with DBusProperty() will be part of the DBus API.
			This allows to define normal, internal properties that won't be visible to the outside.
		*/

		/**
		 * Simple property of type string, that is modifiable.
		 * @type {string}
		 */
		this.Name = 'Initial string'
	}

	/*
		Here we define the methods of the DBus service. They are defined as normal, Javascript methods.
		Note that we can also define methods here that WILL NOT be exposed as a DBus method; only methods that are
		annotated with DBusMethod() will be part of the DBus API.
		This allows to define normal, internal methods that won't be visible to the outside.
	*/

	/**
	 * Simple method that returns the current date, pretty-printed (as a string).
	 * @returns {string} Current date
	 */
	Hello () {
		return new Date().toString()
	}
}

/*
 __  __      _   _               _
|  \/  | ___| |_| |__   ___   __| |___
| |\/| |/ _ \ __| '_ \ / _ \ / _` / __|
| |  | |  __/ |_| | | | (_) | (_| \__ \
|_|  |_|\___|\__|_| |_|\___/ \__,_|___/
*/

/*
	Annotates the method 'Hello' to make it part of the DBus API.
	We specify its name, and its signature (input and output type)
*/
DBusMethod (SimpleService, 'Hello', {
	input: [
	],
	output: [
		{hello_str: t.DBUS_STRING},
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

/*
	Annotates the property 'Name' to make it part of the DBus API.
	We specify its name and its signature (type)
*/
DBusProperty (SimpleService, 'Name', {
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

/*
	Annotates the signal 'Tick' to make it part of the DBus API.
	We specify its name and its signature (output type)
	Note that the signal itself doesn't appear anywhere in the definition of the class, it's because the class
	is an EventEmitter and you just need to call .emit ('Tick', arg1, arg2, ...) to emit the signal.
	See main.js associated main.js file to see an example.
*/
DBusSignal (SimpleService, 'Tick', {
	output: [
		{number: t.DBUS_UINT16},
	],
})

module.exports = SimpleService

// DBus service class generated with DBusGenesis!
