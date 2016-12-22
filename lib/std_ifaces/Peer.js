'use strict';

const fs      = require ('fs')
const debug   = require ('debug')('dbus-native:Peer')
const inspect = require ('util').inspect
const Promise = require ('bluebird')

const signature         = require ('../signature.js')
const DBusInterfaceLibs = require ('../DBusInterfaceLibs.js')

const DBUS_BYTE = signature.DBUS_BYTE
const DBUS_BOOL = signature.DBUS_BOOL
const DBUS_INT16 = signature.DBUS_INT16
const DBUS_UINT16 = signature.DBUS_UINT16
const DBUS_INT32 = signature.DBUS_INT32
const DBUS_UINT32 = signature.DBUS_UINT32
const DBUS_INT64 = signature.DBUS_INT64
const DBUS_UINT64 = signature.DBUS_UINT64
const DBUS_DOUBLE = signature.DBUS_DOUBLE
const DBUS_UNIX_FD = signature.DBUS_UNIX_FD
const DBUS_STRING = signature.DBUS_STRING
const DBUS_OBJ_PATH = signature.DBUS_OBJ_PATH
const DBUS_SIGNATURE = signature.DBUS_SIGNATURE
const DBUS_ARRAY = signature.DBUS_ARRAY
const DBUS_DICT = signature.DBUS_DICT
const DBUS_STRUCT = signature.DBUS_STRUCT
const DBUS_VARIANT = signature.DBUS_VARIANT

const DBusMethod    = DBusInterfaceLibs.DBusMethod
const DBusSignal    = DBusInterfaceLibs.DBusSignal
const DBusProperty  = DBusInterfaceLibs.DBusProperty
const DBusInterface = DBusInterfaceLibs.DBusInterface

/** @module Peer */

/**
 * @class
 * This is the standard DBus interface org.freedesktop.DBus.Peer
 */
class Peer extends DBusInterface {
	constructor (...args) {
		super (...args)

		// We don't need the reference to the service here
		/*
		this.on ('ExposedOnBus', service => {
			// Save service reference so that we can access the properties
			this.__service = service
		})
		//*/
	}

	/**
	 * Simply return with a normal method return, this function is used to maitain a link with a service, by
	 * issuing method call between the those (and maybe check if the service is still alive and running)
	 */
	Ping () {
		return
	}

	/**
	 * Description of Set
	 */
	GetMachineId () {
		return Promise.promisify (fs.readFile) ('/var/lib/dbus/machine-id', 'utf8')
		.then( machineId => {
			// We have to trim because fs.readFile returns the `\n` at the end of the file`
			return machineId.trim()
		})
	}
}

/*
 __  __      _   _               _
|  \/  | ___| |_| |__   ___   __| |___
| |\/| |/ _ \ __| '_ \ / _ \ / _` / __|
| |  | |  __/ |_| | | | (_) | (_| \__ \
|_|  |_|\___|\__|_| |_|\___/ \__,_|___/
*/

DBusMethod (Peer, 'Ping', {
	input: [
	],
	output: [
	],
})

DBusMethod (Peer, 'GetMachineId', {
	input: [
	],
	output: [
		{machine_uuid: DBUS_STRING}
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
 ____  _                   _
/ ___|(_) __ _ _ __   __ _| |___
\___ \| |/ _` | '_ \ / _` | / __|
 ___) | | (_| | | | | (_| | \__ \
|____/|_|\__, |_| |_|\__,_|_|___/
         |___/
*/

module.exports = Peer

// DBus service class generated with DBusGenesis!
