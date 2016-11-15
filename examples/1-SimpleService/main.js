'use strict';

const dbus    = require ('../../index.js')
const inspect = require ('util').inspect
const Promise = require ('bluebird')
const SimpleService = require ('./SimpleService.js')

const DBusService    = dbus.DBusService
const DBusObjectLibs = dbus.DBusObjectLibs

const DBusObject = DBusObjectLibs.DBusObject

// The name we want to expose our DBus service on
const serviceName = 'com.dbus.SimpleService'
// It is common, but not mandatory to have an interface by the same name as the service
const interfaceName = serviceName
// Again, it's common but not mandatory to derive the main object path from the service or interface name.
const objectPath = '/' + serviceName.replace (/\./g, '/')

// We connect and export the service on the session bus
const sessionBus = dbus.sessionBus()
if (!sessionBus) {
	throw new Error ('Could not connect to the DBus session bus.')
}

// Instantiate an interface (containing the methods, signals and properties)
let iface = new SimpleService (interfaceName)

/*
	Create the main object that implements the main interface
	Note that it is also possible to add an interface with `obj.addInterface (iface)`
*/
let obj = new DBusObject (iface) // add the interface directly on build

// Create the service
let service = new DBusService ()

/*
	Add the main object as child to the service (note that the path must be relative: no initial '/')
	Note that we could have pass the obj and the objPath directly in the DBusService() arguments.
*/
service.addObject (obj, objectPath.substr(1))

// Expose the service on the bus so that it's usable by other services and clients
sessionBus.exposeService (service, serviceName) // the call is promisified
.then (() => {
	console.log ('Service exposed and ready to answer calls, with name \'' + serviceName + '\'')

	// This shows how to emit a DBus signal (we make a random part so that it's not too regular)
	setInterval( () => {
		let random = Math.floor (100 * Math.random ())
		let nb = Math.floor (100 * Math.random ())

		if (random > 50)
			iface.emit ('Tick', nb)
	}, 2000)
})
.catch( (err) => {
	console.error ('Failed to exposed service on bus: ' + err)
})

// DBus service class generated with DBusGenesis!
