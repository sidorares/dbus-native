'use strict';

const utils           = require ('./utils.js')
const Errors          = require ('./Errors.js')
const inspect         = require ('util').inspect
const Promise         = require ('bluebird')
const DBusObject2Libs = require ('./DBusObject2Libs.js')

const DBusObject2 = DBusObject2Libs.DBusObject2

// Whether to set this file's functions into debugging (verbose) mode
const DEBUG_THIS_FILE = false

// Allows for setting all files to debug in once statement instead of manually setting every flag
const DEBUG = DEBUG_THIS_FILE || utils.GLOBAL_DEBUG

/** @module DBusService2 */

/**
 * Represent a DBus service that we want to expose on a DBus bus.<br>
 * We can directly pass it a {@link DBusObject2} or add one later with @{link addObject}
 * @param {DBusObject2} [obj]          The DBusObject2 to add as a root object
 * @param {string}      [relativePath] The relative path at which add the object passed in first parameter
 */
function DBusService2 (obj, relativePath) {
	/**
	 * Create an empty DBusObject2 at location '/' to represent the root object.<br>
	 * 'relativePath' will be relative to this '/' root
	 */
	this['/'] = new DBusObject2()

	// If we have a 'DBusObject2' and a 'relativePath', try adding it
	if (typeof obj !== 'undefined' && typeof relativePath !== 'undefined')
		this.addObject (obj, relativePath)

	/**
	 * The service name, as seen on the bus.<br>
	 * Will be populated by {@link module:Bus#exposeService}
	 * @type {string}
	 */
	this.name = undefined

	/**
	 * The bus on which the service is exposed.<br>
	 * Will be populated by {@link module:Bus#exposeService}
	 * @type {Object}
	 */
	this.bus = undefined
}

DBusService2.prototype.addObject = function (object = mandatory(), relativePath = mandatory()) {
	DBusObject2Libs.addObject (this['/'], object, relativePath)
}

/*
DBusService2.prototype.addObject = function (object = mandatory(), relativePath = mandatory()) {
	// Check that 'obj' is a DBusObject2
	if (! (object instanceof DBusObject2)) {
		throw new TypeError (`'object' is not a DBusObject2.`)
	}

	// Check that 'relativePath' is a valid path component to add the child to
	if (!utils.isValidPathComponent (relativePath)) {
		throw new TypeError (`'${relativePath}' is not a valid path component to add an object child at.`)
	}

	// Everything looks good, add the object as child (potentially erasing a previous one)
	this[relativePath] = object
}
//*/
module.exports = DBusService2
