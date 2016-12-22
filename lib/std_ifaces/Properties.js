'use strict';

const debug   = require ('debug')('dbus-native:Properties')
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

/** @module Properties */

/**
 * @class
 * This is the standard DBus interface org.freedesktop.DBus.Properties
 */
class Properties extends DBusInterface {
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
	 * @param {string} interfaceName Name of the interface to which the property belongs to
	 * @param {string} propertyName  Name of the property whose value we must return
	 * Return the value of a property
	 */
	Get (interfaceName, propertyName) {
		debug (`New Get call on '${interfaceName}.${propertyName}''`)
		// Get a reference to the interface containing the property we were queried about
		let targetInterface = this.__dbusObject[interfaceName]
		let propValue
		let propObj
		let propType

		if (targetInterface === undefined)
			throw new Error (`No interface '${interfaceName}' found.`)

		propValue = targetInterface[propertyName]

		if (propValue === undefined)
			throw new Error (`No property '${propertyName}' found in interface '${interfaceName}'.`)

		propObj = targetInterface._ifaceDesc.properties.get(propertyName)

		if (propObj === undefined)
			throw new Error (`No introspection data for property '${propertyName}'`)

		propType = propObj[Object.keys(propObj)[0]]

		return {
			type: propType,
			value: propValue
		}
	}

	/**
	 * @param {string} interfaceName  Name of the interface to which the property belongs to
	 * @param {string} propertyName   Name of the property whose value we will update
	 * @param {Object} value          New value of the property
	 * Update the value of a property
	 */
	Set (interfaceName, propertyName, value) {
		debug (`New set on '${interfaceName}.${propertyName}': '${inspect (value)}'`)
		// Get a reference to the interface containing the property we were queried about
		let targetInterface = this.__dbusObject[interfaceName]

		if (targetInterface === undefined)
			throw new Error (`No interface '${interfaceName}' found.`)

		if (targetInterface[propertyName] === undefined)
			throw new Error (`No property '${propertyName}' found in interface '${interfaceName}'.`)

		targetInterface[propertyName] = value

		/*
			We're not emitting 'PropertiesChanged' here because:
				1. that's not 'org.freedesktop.DBus.Properties.Get()''s job to do that
				2. we used the property's setter to update its value, and it's that setter's job to emit the
				   signal if async mode is not disabled
		*/

		return
	}

	/**
	 * @param {string} interfaceName Name of the interface of which we want to return the properties
	 * Return all readable properties along with their value
	 */
	GetAll (interfaceName) {
		debug (`New GetAll on '${interfaceName}'`)
		let answerDict = {}
		let descProperties
		let targetInterface = this.__dbusObject[interfaceName]

		if (targetInterface === undefined)
			throw new Error (`No interface '${interfaceName}' found.`)

		descProperties = targetInterface._ifaceDesc.properties

		if (descProperties === undefined)
			throw new Error (`No introspection data found on '${interfaceName}'.`)

		// Loop through all annotated properties and add them to the 'answerDict' object
		for (let [propertyName, propAccess] of descProperties) {
			let accessMode = Object.keys(propAccess)[0]

			// DBus spec says 'GetAll' should silently omit properties which can't be accessed
			if (accessMode !== 'write') {
				// Get the property type (used because we return a variant, so we need to type)
				let propType = propAccess[accessMode]

				// Build the variant objet for the property
				let variant = {
					type: propType,
					value: targetInterface[propertyName]
				}

				// Add the variant entry in the return dict
				answerDict[propertyName] = variant
			}
		}

		return answerDict
	}
}

/*
 __  __      _   _               _
|  \/  | ___| |_| |__   ___   __| |___
| |\/| |/ _ \ __| '_ \ / _ \ / _` / __|
| |  | |  __/ |_| | | | (_) | (_| \__ \
|_|  |_|\___|\__|_| |_|\___/ \__,_|___/
*/

DBusMethod (Properties, 'Get', {
	input: [
		{interface_name: DBUS_STRING},
		{property_name: DBUS_STRING},
	],
	output: [
		{value: DBUS_VARIANT},
	],
})

DBusMethod (Properties, 'Set', {
	input: [
		{interface_name: DBUS_STRING},
		{property_name: DBUS_STRING},
		{value: DBUS_VARIANT},
	],
	output: [
	],
})

DBusMethod (Properties, 'GetAll', {
	input: [
		{interface_name: DBUS_STRING},
	],
	output: [
		{props: DBUS_DICT (DBUS_STRING, DBUS_VARIANT)},
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

DBusSignal (Properties, 'PropertiesChanged', {
	output: [
		{interface_name: DBUS_STRING},
		{changed_properties: DBUS_DICT (DBUS_STRING, DBUS_VARIANT)},
		{invalidated_properties: DBUS_ARRAY (DBUS_STRING)},
	],
})

module.exports = Properties

// DBus service class generated with DBusGenesis!
