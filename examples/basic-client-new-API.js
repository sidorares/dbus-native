'use strict';

const dbus    = require ('../index.js')
const inspect = require ('util').inspect
const Promise = require ('bluebird')

/*
	This example file's purpose is to demonstrate how to make a simple, basic with the new API (DBus proxy).
	In order to do that, we connect to the session bus, create a DBus Service to target a distant DBus service.
	We demonstrate how to make various method calls, how to get and set property values and how to listen for signals.
	Make sure to start the basic service with `node basic-server-new-API.`js` before.

	For information, the spirit of the binding with the DBusProxy is this one: you create a DBusProxy which is an object
	that represents the remote DBus service.
	This object is as close as possible to the service, so that you can abstract your work: the fact that you are
	working with a remote DBus service should be transparent to you, so:
	- to make a method call, simply call a function on the proxy you have
	- properties are getter/setters, so simply get or set the proeprty like a normal Javascript property
	- interfaces are EventEmitter, and the binding takes care of matching the DBus signal with the Javascript signals,
	  so to listen to a DBus signal, you simply listen to the Proxy (EventEmitter) signal

	It is _really_ all that simply. Obviously, this all of this is asynchronous, everything that was just described is
	implemented as promised.
*/

// Firt we need to connect to the bus (session or system0)
const sessionBus = dbus.sessionBus()

// Name of the service we will make a proxy for
const targetService = 'com.dbus.native.basic.service'


/*
	This is the call that actually makes the magic happen and create the DBusProxy
*/
sessionBus.getService2 (targetService)
.then( (service) => {
	/*
		Once this call returns, it has created a DBusProxy for us, with everythign that was described above available.

		Attributes of the DBusProxy are the children object (DBusObject)
		So here 'com' represents the '/com' object, which just has the 'dbus' object, so 'service.com.dbus' is
		the object '/com/dbus' etc.
		To save typing we save the object we are interested in an 'obj' variable.
		When we reach an object that has interfaces, they are string properties whose name is the full string name of
		the interface.
	*/
	let obj = service.com.dbus.native.basic.service // That's traversing the hierarchy, DBus-style

	// Switch to 'true' to display the service completely
	if (false) {
		console.log ('Got service:')
		console.log (inspect (service, {colors: true, depth: 6}))
	}

	// Accessing a property is calling the function whose name is the property's, with no argument. Promise-based.
	obj["com.dbus.native.basic.service"].Flag() // That's a normal getter (but promisified)
	.then( flagValue => {
		/*
			We actually got the value here whe nthe getter returns.
			Though this is promised-based, the value is returned immediately, because the property value is stored
			locally in the DBusInterface2. It is updated automatically when 'PropertiesChanged' is received.
		*/
		console.log ('flag (before): ' + flagValue)
		return flagValue
	})
	.then( flagValue => {
		/*
			Here is how we change the value of a property.
			We simply call the same function (function's name is the property's) with ONE argument: the new value
			It's promise-based, it returns when the DBus SET was transmitted to the daemon and it answered us.
			NOTE: it does NOT change the DBusInterface's property value directly, but the interface listens for the
			'PropertiesChanged' signal to update its property's value.
			This is done so that the proxy doesn't get update if the DBus SET call fails for some reason.
		*/
		return obj["com.dbus.native.basic.service"].Flag(!flagValue) // simple setter syntaxt (but promisified)
	})
	.then( () => {
		// Here we query for the property value again, to show that the binding does work
		return obj["com.dbus.native.basic.service"].Flag()
	})
	.then( newFlagValue => {
		// Display this new value
		console.log ('flag (after): ' + newFlagValue)
	})
	.catch( err => {
		// Should not arrive: no errors here, but still safe to gracefully react
		console.error ('>> Error: ' + err)
	})

	/*
		Here we show how simple it is to listen to a signal: it's simply an EventEmitter!
		Let the binding worry about translating DBus signals into EventEmitter signals!
	*/
	obj["com.dbus.native.basic.service"].on ('Rand', nb => {
		console.log ('Rand gave out: ' + nb)
	})

	/*
		Same thing, just to show that complex, container types get marshalled correctly
	*/
	obj["com.dbus.native.basic.service"].on ('TestSig', arg => {
		console.log ('TestSig arg: ' + inspect (arg))
		// console.log ('TestSig str: ' + str)
		// console.log ('TestSig bool: ' + bool)
	})

	// The small wait here is just made so that the output doesn't all come in one.
	setTimeout (() => {
		/*
			This demonstrates how to make method clal: simply call the interface's method.
			Obf course this is asynchronous so it's promised-based, but this is the only real gotcha!
		*/
		obj["com.dbus.native.basic.service"].Capitalize ('lower String')
		.then( (ret) => {
			console.log ('Capitalized returned: ' + ret)
		})
		.catch( (err) => {
			console.error ('Capitalized failed with: ' + err)
		})
	}, 1400)

	setTimeout (() => {
		// Another method call, SayHello
		obj['com.dbus.native.basic.service'].SayHello()
		.then( (ret) => {
			console.log ('Method call \'SayHello\' returned: ' + ret)
		})
		.catch( (err) => {
			console.error (fn + ' returned failed with: ' + err)
		})
	})
})
.catch( (err) => {
	console.error ('/!\\ An error occured /!\\')
	console.error (err)
})
