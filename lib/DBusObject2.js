'use strict';

const utils      = require ('./utils.js')
const Errors     = require ('./Errors.js')
const inspect    = require ('util').inspect
const xmlbuilder = require ('xmlbuilder')

const mandatory = utils.mandatory

const InvalidNameError = Errors.InvalidNameError

/** @module DBusObject2 */

/**
 * Represents a DBus Object.<br>
 * A DBusObject can have other (children) objects, and/or one (of several) interfaces.
 *
 *
 * @throws {module:Errors#InvalidNameError}
 */
class DBusObject2 {
	constructor () {
		// Nothing special about objects? o_O
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
	_introspect () {
		let keys = Object.keys (this)
		let ifaces = keys.filter (utils.isValidIfaceName)
		let objs = keys.filter (utils.isValidPathComponent)
		let xml = xmlbuilder.create ('node', {headless: true}) // Create root element without the <?xml version="1.0"?>
		                    .dtd ('-//freedesktop//DTD D-BUS Object Introspection 1.0//EN',
		                          'http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd')
		                    .root() // don't forget to return to the root elem so that elems are not added to the DTD

		// Have each interface generate its introspection data and add it to the root XML element
		for (let iface of ifaces) {
			this[iface]._introspect (xml)
		}

		// List each object as nodes
		for (let obj of objs) {
			xml.ele ('node', {name: obj})
		}

		// console.log (xml.end ({pretty: true}))

		// Return the XML string
		return xml.end ({pretty: true})
	}

}

module.exports = DBusObject2

// module.exports = {
// 	DBusService2
// }
