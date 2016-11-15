'use strict';

const utils             = require ('./utils.js')
const Errors            = require ('./Errors.js')
const inspect           = require ('util').inspect
const stdifaces         = require ('./stdifaces.js')
const xmlbuilder        = require ('xmlbuilder')
const DBusInterfaceLibs = require ('./DBusInterfaceLibs')

const mandatory = utils.mandatory

const InvalidNameError = Errors.InvalidNameError

const DBusInterface = DBusInterfaceLibs.DBusInterface

// Whether to set this file's functions into debugging (verbose) mode
const DEBUG_THIS_FILE = false

// Allows for setting all files to debug in once statement instead of manually setting every flag
const DEBUG = DEBUG_THIS_FILE || utils.GLOBAL_DEBUG

/** @module DBusObject */

/**
 * Represents a DBus Object.<br>
 * A DBusObject can have other (children) objects, and/or one (of several) interfaces.
 *
 * @param {DBusObject|DBusInterface} [objOrIface] - Optional object or interface to create as child for this object
 *
 * @throws {module:Errors#InvalidNameError}
 */
class DBusObject {
	constructor (objOrIface, relativePath) {
		// If the object is passed a DBusObject and we have a 'relativePath', make it a child
		if (typeof objOrIface !== 'undefined' && objOrIface instanceof DBusObject && typeof relativePath !== 'undefined') {
			this.addObject (objOrIface, relativePath)
		}
		// If the object is passed a DBusInterface, add it to this Object
		else if (typeof objOrIface !== 'undefined' && objOrIface instanceof DBusInterface) {
			// If DEBUG is on, warn the user in case a relative path is given with the interface
			if (DEBUG && typeof relativePath !== 'undefined')
				console.warn ('A relative path was given although an interface was passed, the name is useless and will be discarded')

			this.addInterface (objOrIface)
		}
		// Otherwise fail so that the user doesn't think whatever was passed was actually added
		else if (typeof objOrIface !== 'undefined') {
			throw new TypeError (`DBusObject can only be created with an child object or an interface (or nothing).`)
		}
	}

	/**
	 * Generate introspection data for this object.<br>
	 * What it does is:
	 * <ul>
	 * <li>have all ints interfaces generate its introspection data</li>
	 * <li>list all children nodes (not the complete introspection data)</li>
	 * <li>concatenate and return</li>
	 * </ul>
	 */
	introspect () {
		let keys = Object.keys (this)
		let ifaces = keys.filter (utils.isValidIfaceName)
		let objs = keys.filter (utils.isValidPathComponent)
		let xml = xmlbuilder.create ('node', {headless: true}) // Create root element without the <?xml version="1.0"?>
		                    .dtd ('-//freedesktop//DTD D-BUS Object Introspection 1.0//EN',
		                          'http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd')
		                    .root() // don't forget to return to the root elem so that elems are not added to the DTD

		// Have each interface generate its introspection data and add it to the root XML element
		for (let iface of ifaces) {
			this[iface].introspect (xml)
		}

		// Insert standard interfaces description
		stdifaces.stdPeerIface (xml)
		stdifaces.stdIntrospectableIface (xml)
		stdifaces.stdPropertiesIface (xml)

		// List each object as nodes
		for (let obj of objs) {
			xml.ele ('node', {name: obj})
		}

		// console.log (xml.end ({pretty: true}))

		// Return the XML string
		return xml.end ({pretty: true})
	}

	/**
	 * Add an interface (and thus a set of functions, methods and signals) to an Object
	 * @param {DBusInterface} iface  The interface to add to the object
	 * @throws {TypeError}
	 */
	addInterface (iface = mandatory()) {
		// Check that 'iface' is a DBusInterface
		if (! (iface instanceof DBusInterface)) {
			throw new TypeError (`'iface' is not a DBusInterface.`)
		}

		// Check if the iface we're trying to add has a valid name
		if (!utils.isValidIfaceName (iface._ifaceName)) {
			throw new TypeError (`'${iface._ifaceName}' is not a valid interface name.`)
		}

		// Everything looks good, proceed to add the interface to the object (erasing the previously one if present)
		this[iface._ifaceName] = iface

		// TODO: Implement & emit 'Interface added' from Object Manager
	}

	/**
	 * Add a {@link DBusObject} as a child of this one.
	 */
	addObject (object = mandatory(), relativePath = mandatory()) {
		addObject (this, object, relativePath)
 	}
}

/**
 * Used to add a child object to either a {@link DBusService} or a {@link DBusObject}.
 * @param {DBusService|DBusObject} parent The object to which add the child
 * @param {DBusObject}              object The child object to add
 * @param {string}             relativePath The relative path at which add the child object
 *
 * @throws {TypeError}
 */
function addObject (parent = mandatory(), object = mandatory(), relativePath = mandatory()) {
	let pathComponents = relativePath.split ('/')

	// Check that 'object' is a DBusObject
	if (! (object instanceof DBusObject)) {
		throw new TypeError (`'object' is not a DBusObject.`)
	}

	// Check that all paths components are valid
	if (!pathComponents.every (utils.isValidPathComponent)) {
		throw new TypeError (`'${relativePath}' contains non-valid path components.`)
	}

	/*
		Everything looks good, traverse the object according to the path components, and add the obj as child
	*/
	let currObj = parent
	// traverse the object
	while (pathComponents.length > 1) {
		let currPathComponent = pathComponents.shift()

		// If the current object doesn't already have an object at this path component, create one
		if (typeof currObj[currPathComponent] === 'undefined') {
			currObj[currPathComponent] = new DBusObject()
		}

		// traverse the object
		currObj = currObj[currPathComponent]
	}

	// Now we have traversed our object and reached the object path to host the child, so add it
	currObj[pathComponents.shift()] = object
}

module.exports = {
	DBusObject,
	addObject,
}
