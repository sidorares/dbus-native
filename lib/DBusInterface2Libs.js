'use strict';

const utils          = require ('./utils.js')
const Errors         = require ('./Errors.js')
const signature      = require ('./signature.js')
const EventEmitter   = require ('events')

const isSigSignatureObj  = signature.isSigSignatureObj
const isFuncSignatureObj = signature.isFuncSignatureObj
const isPropSignatureObj = signature.isPropSignatureObj

const mandatory = utils.mandatory

const InvalidNameError = Errors.InvalidNameError

/** @module DBusInterface2Libs */

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

		/**
		 * Description of the interface, used for introspection.<br>
		 * This is not intended to be manipulated directly, but rather through the functions 'DBusMethod'
		 * @type {object}
		 * @private
		 */
		this._ifaceDesc = {
			methods: new Map(),
			properties: new Map(),
			signals: new Map(),
		}
	}
}

/**
 * Used to "annotate" a {@link DBusInterface2} and add a function to expose to the interface.
 * @param {DBusInterface2} iface - The interface on which to add the function
 * @param {string} funcName - The name of the function, as exposed on bus (there must be a method of the interface with
 *                            that name)
 * @param {Object} funcSignature - A signature-formatted object containing the function's signature (see example for
 *                                 what is a signature-formatted object)
 */
function DBusMethod (iface = mandatory(), funcName = mandatory(), funcSignature = mandatory()) {
	// Check if 'iface' is a DBusInterface2
	if (! (iface instanceof DBusInterface2)) {
		throw new TypeError ('\'DBusMethod()\' can only annotate DBusInterface2 objects.')
	}

	// Check if 'funcName' is a string
	if (typeof funcName !== 'string') {
		throw new TypeError ('\'funcName\' must be the function name (a string, and not a \'' + typeof funcName + '\')')
	}

	// Check if 'funcSignature' is a correctly-formatted signature object
	if (!isFuncSignatureObj (funcSignature)) {
		throw new TypeError ('\'funcSignature\' must be a properly-formatted signature object (see example)')
	}

	// Now check that there _is_ indeed a function named 'funcName' in the DBusInterface2
	if (typeof iface[funcName] !== 'function') {
		throw new TypeError (`No function '${funcName}' found in interface`)
	}

	// Add the introspection data to the introspection structure (possibly updating / overiding previous value)
	iface._ifaceDesc.methods.set (funcName, funcSignature)
}

/**
 * Used to "annotate" a {@link DBusInterface2} and add a property to expose to the interface.
 * @param {DBusInterface2} iface - The interface on which to add the property
 * @param {string} propName - The name of the property, as exposed on bus (there must be a property of the interface
 *                            with that name)
 * @param {Object} propSignature - A signature-formatted object containing the property's signature (see example for
 *                                 what is a signature-formatted object)
 */
function DBusProperty (iface = mandatory(), propName = mandatory(), propSignature = mandatory()) {
	// Check if 'iface' is a DBusInterface2
	if (! (iface instanceof DBusInterface2)) {
		throw new TypeError ('\'DBusProperty()\' can only annotate DBusInterface2 objects.')
	}

	// Check if 'propName' is a string
	if (typeof propName !== 'string') {
		throw new TypeError ('\'propName\' must be the property name (a string, and not a \'' + typeof propName + '\')')
	}

	// Check if 'propSignature' is a correctly-formatted signature object
	if (!isPropSignatureObj (propSignature)) {
		throw new TypeError ('\'propSignature\' must be a properly-formatted signature object (see example)')
	}

	// Now check that there _is_ indeed a property named 'propName' in the DBusInterface2
	// TODO: check that the type of the property actually matches the supplied-signature type
	if (typeof iface[propName] === 'function' || typeof iface[propName] === 'undefined') {
		throw new TypeError (`No property '${propName}' found in interface`)
	}

	// Add the introspection data to the introspection structure (possibly updating / overiding previous value)
	iface._ifaceDesc.properties.set (propName, propSignature)
}

/**
 * Used to "annotate" a {@link DBusInterface2} and add a signal to expose to the interface.
 * @param {DBusInterface2} iface - The interface on which to add the property
 * @param {string} sigName - The name of the signal, as exposed on bus
 * @param {Object} sigSignature - A signature-formatted object containing the signal's signature (see example for
 *                                 what is a signature-formatted object)
 */
function DBusSignal (iface = mandatory(), sigName = mandatory(), sigSignature = mandatory()) {
	// Check if 'iface' is a DBusInterface2
	if (! (iface instanceof DBusInterface2)) {
		throw new TypeError ('\'DBusSignal()\' can only annotate DBusInterface2 objects.')
	}

	// Check if 'sigName' is a string
	if (typeof sigName !== 'string') {
		throw new TypeError ('\'sigName\' must be the property name (a string, and not a \'' + typeof sigName + '\')')
	}

	// Check if 'sigSignature' is a correctly-formatted signature object
	if (!isSigSignatureObj (sigSignature)) {
		throw new TypeError ('\'sigSignature\' must be a properly-formatted signature object (see example)')
	}

	// Add the introspection data to the introspection structure (possibly updating / overiding previous value)
	iface._ifaceDesc.signals.set (sigName, sigSignature)
}

module.exports = {
	DBusInterface2,
	DBusMethod,
	DBusProperty,
	DBusSignal,
}
