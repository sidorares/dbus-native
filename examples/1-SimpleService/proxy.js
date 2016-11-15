'use strict';

const dbus    = require ('../../index.js')
const inspect = require ('util').inspect
const Promise = require ('bluebird')

const DBusService    = dbus.DBusService
const DBusObjectLibs = dbus.DBusObjectLibs

const DBusObject = DBusObjectLibs.DBusObject

const serviceName = 'com.dbus.SimpleService'
const interfaceName = serviceName
const objectPath = '/' + serviceName.replace (/\./g, '/')

const sessionBus = dbus.sessionBus()
if (!sessionBus) {
	throw new Error ('Could not connect to the DBus session bus.')
}

sessionBus.mkProxy (serviceName)
.then( service => {
	let obj = service.com.dbus.SimpleService
	let iface = obj[interfaceName]

	/*
		This is how we listen for a DBus signal.
		DBus signals are re-emitted into EventEmitter signals, so it's just a matter of listening for this normal,
		EventEmitter, Javascript signal.
	*/
	iface.on ('Tick', nb => {
		console.log (`Tick returned: ${nb}`)
	})

	// Here we call the function 'Hello', this is promisified (because asynchronous)
	return iface.Hello()
	.then( str => {
		// We get the return value from 'Hello()'
		console.log (`Hello() returned: ${str}`)
	})
	.then( () => {
		// Here we call the Getter of the property, again, promisified (even though properties are cached)
		return iface.Name()
	})
	.then( name => {
		// We've got the property value now
		console.log (`Name is '${name}'`)
		console.log (`Changing it...`)

		// Here we call the Setter, it's the same as the getter, but with one parameter: the new property value
		return iface.Name ('Other name')
	})
	.then( () => {
		// Then after we set the property, we request it again, to witness the change
		return iface.Name()
	})
	.then( newName => {
		// New property value
		console.log (`New name: ${newName}`)
	})
	.catch( err => {
		console.error (`[Error] ${err}`)
	})
})
