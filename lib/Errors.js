'use strict';

const utils = require ('./utils')

const mandatory = utils.mandatory

/** @module Errors */

/**
 * Error indicating that a name (either service, interface or error) is not valid with the DBus naming convention.
 */
class InvalidNameError extends Error {
	constructor (invalidName = mandatory(), message = `${invalidName} is not a valid DBus name.`) {
		super (message)
		this.name = 'InvalidNameError'
	}
}

/**
 * Error indicating that a feature is not yet implemented.
 */
class NotImplementedError extends Error {
	constructor (message = mandatory()) {
		super (message)
		this.name = 'NotImplementedError'
	}
}

/**
 * Error indicating that a requested service is not available on the bus
 */
class ServiceUnknownError extends Error {
	constructor (serviceName = mandatory(), message = `The name ${serviceName} was not provided by any .service files.`) {
		super (message)
		this.name = 'ServiceUnknownError'
	}
}

/**
 * Error indicating that a number is outside range.
 */
class RangeError extends Error {
	constructor (number = mandatory(), min = mandatory(), max = mandatory(), message = `Number ${number} is outside its range [${min}, ${max}]`) {
		super (message)
		this.name = 'RangeError'
	}
}

module.exports = {
	InvalidNameError,
	NotImplementedError,
	ServiceUnknownError,
	RangeError,
}
