'use strict';

const dbus    = require ('../../index.js')
const inspect = require ('util').inspect
const BasicService = require ('./BasicService.js')

const DBusService    = dbus.DBusService
const DBusObjectLibs = dbus.DBusObjectLibs

const DBusObject = DBusObjectLibs.DBusObject2

// The name we want to expose our DBus service on
const serviceName = 'com.dbus.native.basic.service'
const interfaceName = serviceName
const objectPath = '/' + serviceName.replace (/\./g, '/')

const sessionBus = dbus.sessionBus()
if (!sessionBus) {
	throw new Error ('Could not connect to the DBus session bus.')
}

let iface = new BasicService (interfaceName)

/*
	Create the main object that implements the main interface
	Note that it is also possible to add an interface with `obj.addInterface (iface)`
*/
let obj = new DBusObject (iface) // add the interface directly on build

// Create the service
let service = new DBusService ()

// Add the main object as child to the service (note that the path must be relative: no initial '/')
service.addObject (obj, objectPath.substr(1))

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

// Expose the service on the bus so that it's usable by other services and clients
sessionBus.exposeService (service, serviceName) // the call is promisified
.then (() => {
	console.log ('Service exposed and ready to answer calls, with name \'' + serviceName + '\'')
})
.catch( (err) => {
	console.error ('Failed to exposed service on bus: ' + err)
})

// DBus service class generated with DBusGenesis!
