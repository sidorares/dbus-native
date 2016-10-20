'use strict';

const dbus    = require ('../index.js')
const inspect = require ('util').inspect
const Promise = require ('bluebird')

/*
	This example file's purpose is to demonstrate how to make a simple, basic with the new API (DBus proxy).
	In order to do that, we connect to the session bus, create a DBus Service to target a distant DBus service.
	We demonstrate how to make various method calls, how to get and set property values and how to listen for signals.
	Make sure to start the basic service with `node basic-server.`js` before.
*/

const sessionBus = dbus.sessionBus()

// Name of the service we will make a proxy for
const targetService = 'com.dbus.native.basic.service'

sessionBus.getService2 (targetService) // actual call to create a proxy for the service
.then( (service) => { // `service` is a DBusService2
	/*
		Attributes of the DBusService are the children object (DBus sense)
		So here 'com' represents the '/com' object, which just has the 'dbus' object, so 'service.com.dbus' is
		the object '/com/dbus' etc.
		To save typing we save the object we are interested in in a 'obj' variable.
		When we reach an object that has interfaces, they are string properties whose name is the full string name of
		the interface.
	*/
	let obj = service.com.dbus.native.basic.service

	// Switch to 'false' not to display the final service
	if (true) {
		console.log ('Got service:')
		console.log (inspect (service, {colors: true, depth: 6}))
	}

	// Make a function call, just to check. Make it random to see that several functions call actually work
	let fn = Math.round (Math.random() * 100) >= 50
		? 'SayHello'
		: 'GiveTime'

	// Accessing a property is calling the function whose name is the property's, with no argument. Promise-based.
	obj["com.dbus.native.basic.service"].Flag()
	.then( (flagValue) => {
		/*
			We actually got the value here.
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
		return obj["com.dbus.native.basic.service"].Flag(!flagValue)
	})
	.then( () => {
		// Here we query for the property value again, to show that the binding does work
		return obj["com.dbus.native.basic.service"].Flag()
	})
	.then( newFlagValue => {
		// Display this new value
		console.log ('flag (after): ' + newFlagValue)
	})
	.catch( (err) => {
		// Should not arrive: no errors here, but still safe to gracefully react
		console.error ('>> Error: ' + err)
	})

	/*
		An interface can have signals too, so here is how we listen to a signal from the interface
	*/
	obj["com.dbus.native.basic.service"].on ('Rand', nb => {
		console.log ('Rand gave out: ' + nb)
	})

	// The small wait here is just made so that the output doesn't all come in one.
	setTimeout (() => {
		// Here is how to make a method call on the proxy, we call Capitalize
		obj["com.dbus.native.basic.service"].Capitalize ('lower String')
		.then( (ret) => {
			console.log ('Capitalized returned: ' + ret)
		})
		.catch( (err) => {
			console.error ('Capitalized failed with: ' + err)
		})
	}, 1400)

	setTimeout (() => {
		// Another method call, randomized
		obj['com.dbus.native.basic.service'][fn]()
		.then( (ret) => {
			console.log ('Method call ' + fn + ' returned: ' + ret)
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
