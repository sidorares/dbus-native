'use strict';

const utils        = require ('./utils.js')
const Errors       = require ('./Errors.js')
const EventEmitter = require ('events')

const mandatory = utils.mandatory

const InvalidNameError = Errors.InvalidNameError

/** @module DBusInterface2 */

/**
 * Represents a DBus Interface.<br>
 * A DBusInterface can have some properties, some methods and can emit some signals
 *
 *
 * @throws {module:Errors#InvalidNameError}
 */
class DBusInterface2 extends EventEmitter {
	constructor (ifaceName = mandatory()) {
		super()
		// Check if the interface name respects DBus naming rules
		if (!utils.isValidIfaceName (ifaceName)) {
			throw new InvalidNameError (ifaceName)
		}

		/**
		 * Name of the interface.<br>
		 * An interface is an entity in itself, so it makes sense that it has a name. Several objects can have the same
		 * interface, but htis is the <em>same</em> interface, so it's "identified", the name is coherent. Unlike
		 * objects.
		 * @type {string}
		 */
		this.name = ifaceName
	}
}

module.exports = DBusInterface2
