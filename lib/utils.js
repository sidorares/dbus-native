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
const DBUS_INTERFACE_NAME_REGEX = /^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)+$/

/**
 * Regex that validate a path <strong>component</strong> (not an entire path)
 * @type {regex}
 */
const DBUS_OBJ_PATH_COMPONENT_REGEX = /^[a-zA-Z]\w*$/

///////////////////////////////////////////////////////////////////////////////////
// DBus constants, do not change value, they are based on the DBus specification //
///////////////////////////////////////////////////////////////////////////////////
// Flags to request a name
const DBUS_NAME_FLAG_ALLOW_REPLACEMENT = 0x1 // allows someone to steal our name
const DBUS_NAME_FLAG_REPLACE_EXISTING  = 0x2 // try to steal the name from someone
const DBUS_NAME_FLAG_DO_NOT_QUEUE      = 0x4 // do not queue us if we can't get or steal the name and fail instead
// Return code when requesting a name
const DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER = 0x1  // OK, you are the name's owner now
const DBUS_REQUEST_NAME_REPLY_IN_QUEUE      = 0x2  // name already has an owner, you are in queue for it
const DBUS_REQUEST_NAME_REPLY_EXISTS        = 0x3  // NOK, name already has an owner, you were not queued
const DBUS_REQUEST_NAME_REPLY_ALREADY_OWNER = 0x4  // you are already the name's owner

/**
 * Test whether a name respects DBus interface naming convention<br>
 *
 * @param {string} name - The name to check for validity
 * @returns {boolean} Whether the name is valid or not, according to DBus naming rules
 * @see https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface
 */
function isValidIfaceName (name) {
	if (typeof name !== 'string' || name.length >= DBUS_MAX_NAME_LENGTH || ! DBUS_INTERFACE_NAME_REGEX.test (name)) {
		return false
	} else {
		return true
	}
}

function isValidPathComponent (name) {
	if (typeof name !== 'string' || name.length >= DBUS_MAX_NAME_LENGTH || ! DBUS_OBJ_PATH_COMPONENT_REGEX.test (name)) {
		return false
	} else {DBUS_NAME_FLAG_REPLACE_EXISTING
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
	GLOBAL_DEBUG,
	DBUS_NAME_FLAG_ALLOW_REPLACEMENT,
	DBUS_NAME_FLAG_REPLACE_EXISTING,
	DBUS_NAME_FLAG_DO_NOT_QUEUE,
	DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER,
	DBUS_REQUEST_NAME_REPLY_IN_QUEUE,
	DBUS_REQUEST_NAME_REPLY_EXISTS,
	DBUS_REQUEST_NAME_REPLY_ALREADY_OWNER,
	mandatory,
	isValidIfaceName,
	isValidErrorName: isValidIfaceName, // turns out, Error names must respect the same rules as interface names
	isValidPathComponent,
}
