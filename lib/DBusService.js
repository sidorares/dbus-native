'use strict';

const utils          = require ('./utils.js')
const Errors         = require ('./Errors.js')
const inspect        = require ('util').inspect
const Promise        = require ('bluebird')
const DBusObjectLibs = require ('./DBusObjectLibs.js')

const DBusObject = DBusObjectLibs.DBusObject

// Whether to set this file's functions into debugging (verbose) mode
const DEBUG_THIS_FILE = false

// Allows for setting all files to debug in once statement instead of manually setting every flag
const DEBUG = DEBUG_THIS_FILE || utils.GLOBAL_DEBUG

/** @module DBusService */

/**
 * Represent a DBus service that we want to expose on a DBus bus.<br>
 * We can directly pass it a {@link DBusObject} or add one later with @{link addObject}
 * @param {DBusObject} [obj]          The DBusObject to add as a root object
 * @param {string}      [relativePath] The relative path at which add the object passed in first parameter
 */
function DBusService (obj, relativePath) {
	/**
	 * Create an empty DBusObject at location '/' to represent the root object.<br>
	 * 'relativePath' will be relative to this '/' root
	 */
	this['/'] = new DBusObject()

	// If we have a 'DBusObject' and a 'relativePath', try adding it
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

DBusService.prototype.addObject = function (object = mandatory(), relativePath = mandatory()) {
	DBusObjectLibs.addObject (this['/'], object, relativePath)
}
module.exports = DBusService
