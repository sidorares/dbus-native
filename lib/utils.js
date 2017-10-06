'use strict';

/** @module Utils */

/*
	This module contains util functions, wrappers and constants that are useful for the whole lib
*/

// Set to true to switch all library files into debug mode
const GLOBAL_DEBUG = false

/**
 * Maximum name length for interface or error name that DBus allows
 * @type {number}
 */
const DBUS_MAX_NAME_LENGTH = 255

/**
 * Regex that validates an interface or error name (have to check max length first)
 * @type {regex}
 */
const DBUS_NAME_REGEX = /^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)+$/

/**
 * Test whether a name respects DBus naming convention.<br>
 *
 * @param {string} name - The name to check for validity
 * @returns {boolean} Whether the name is valid or not, according to DBus naming rules
 * @see https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface
 */
function isNameValid (name) {
	if (typeof name !== 'string' || name.length >= DBUS_MAX_NAME_LENGTH || ! DBUS_NAME_REGEX.test (name)) {
		return false
	} else {
		return true
	}
}

/**
 * Convenient function to put as default value for function's argument that we want to make mandatory.<br>
 * It throws an error so that the user knows he missed a mandatory argument.
 *
 * @throws {TypeError}
 */
function mandatory () {
	throw new TypeError ('Missed a mandatory argument in function call!')
}

module.exports = {
	DBUS_MAX_NAME_LENGTH,
	DBUS_NAME_REGEX,
	GLOBAL_DEBUG,
	mandatory,
	isNameValid
}
