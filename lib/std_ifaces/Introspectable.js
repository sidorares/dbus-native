'use strict';

const debug      = require ('debug')('dbus-native:Introspectable')
const inspect    = require ('util').inspect
const Promise    = require ('bluebird')
const xmlbuilder = require ('xmlbuilder')

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

const docType = '<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"\n' +
' "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">'

/** @module Introspectable */

/**
 * @class
 * This is the standard DBus interface org.freedesktop.DBus.Introspectable
 */
class Introspectable extends DBusInterface {
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
	 * Return an XML-formatted string describing all methods, properties and signals for the interface
	 */
	Introspect () {
		return this.__dbusObject.introspect()
	}
}

/*
 __  __      _   _               _
|  \/  | ___| |_| |__   ___   __| |___
| |\/| |/ _ \ __| '_ \ / _ \ / _` / __|
| |  | |  __/ |_| | | | (_) | (_| \__ \
|_|  |_|\___|\__|_| |_|\___/ \__,_|___/
*/

DBusMethod (Introspectable, 'Introspect', {
	input: [
	],
	output: [
		{xml_data: DBUS_STRING}
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

module.exports = Introspectable

// DBus service class generated with DBusGenesis!
