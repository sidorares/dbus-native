'use strict';

const utils  = require ('./utils.js')
const Errors = require ('./Errors.js')

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
function DBusObject2 () {
	// Nothing special about objects? o_O
}

module.exports = DBusObject2

// module.exports = {
// 	DBusService2
// }
