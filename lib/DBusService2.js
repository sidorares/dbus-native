'use strict';

const utils          = require ('./utils.js')
const Errors         = require ('./Errors.js')
const inspect        = require ('util').inspect
const Promise        = require ('bluebird')
const libxmljs       = require ('libxmljs')
const signature      = require ('./signature.js')
const DBusObject2    = require ('./DBusObject2.js')
const DBusInterface2 = require ('./DBusInterface2.js')

const mandatory = utils.mandatory

const InvalidNameError = Errors.InvalidNameError

// Whether to set this file's functions into debugging (verbose) mode
const DEBUG_THIS_FILE = true

// Allows for setting all files to debug in once statement instead of manually setting every flag
const DEBUG = DEBUG_THIS_FILE || utils.GLOBAL_DEBUG

/** @module DBusService2 */

/**
 * Represents a DBus service.<br>
 * A DBusService has at least a service name (the well-known name on which it can be accessed on the bus).
 *
 * @param {string} serviceName           The service name on which it can be accessed on the bus
 * @param {Object} bus                   The bus (generally session or system) on which the service is exposed
 * @param {number} maxIntrospectionDepth Maximum number of introspection recursion calls
 *
 * @throws {module:Errors#InvalidNameError}
 * @throws {TypeError}
 */
function DBusService2 (serviceName = mandatory(), bus = mandatory(), maxIntrospectionDepth = Infinity) {
	// Check if the service name respects the DBus naming convention and assign it if it does.
	if (!utils.isValidIfaceName (serviceName)) {
		throw new InvalidNameError (serviceName)
	}

	// Check if the max introsp. depth is valid
	if (isNaN (maxIntrospectionDepth) || maxIntrospectionDepth < 0) {
		throw new TypeError (`'maxIntrospectionDepth' must be a positive number or 'Infinity'`)
	}

	/**
	 * The service name, as seen on the bus
	 * @type {string}
	 */
	this.name = serviceName

	/**
	 * The bus on which the service is exposed
	 * @type {Object}
	 */
	this.bus = bus

	// Make the introspection pass to populate the DBus Service
	return this.makeIntrospectionPass (maxIntrospectionDepth, this, '/')
	.then( () => {
		return this
	})
}

/**
 * Make the introspection pass:
 * - make introspection call to the service name
 * - For each of the object path nodes:
 *      * create a DBusObject and assign it as a field to this DBusService
 *      * make introspection call for this object too and recurse until we re reach the bottom of the tree (iface)
 *      * For each of the interfaces:
 *           + make an introspection call and create properties, functions and signals
 *
 * @param {object} parent The object (DBusService, DBusObject or DBusInterface) that will contain the introspected data
*/
DBusService2.prototype.makeIntrospectionPass = function (introspectionDepth, parent, path) {
	if (!isNaN (introspectionDepth) && introspectionDepth > 0) {
		let newDepth = introspectionDepth - 1
		let msg

		if (DEBUG) console.log ('Introspecting \'' + path + '\'')

		// Message for 'Introspect' method call
		msg = {
			path,
			destination: this.name,
			'interface': 'org.freedesktop.DBus.Introspectable',
			member: 'Introspect'
		}

		// Make the introspection call
		return Promise.promisify (this.bus.invoke) (msg)
		.then( (xml) => {
			// Parse the XML introspection data
			let doc = libxmljs.parseXml (xml)

			// Find all interfaces...
			let ifaces = doc.find ('interface[@name]')
			console.log ('Found ifaces: ' + ifaces.toString())
			//... and all nodes...
			let nodes = doc.find ('node[@name]')
			console.log ('Found nodes: ' + nodes.toString())

			//... and return them
			return {
				ifaces,
				nodes
			}
		})
		.then( (introspectData) => {
			let ifaces = introspectData.ifaces
			let nodes = introspectData.nodes
			let recursiveNodes = []
			let allProperties = []

			// First deal with interfaces: if we found some, let's create DBusInterfaces
			for (let iface of ifaces) {
				let name = iface.attr('name').value()
				if (DEBUG) console.log ('Found interface ' + name)

				if (utils.isValidIfaceName (name)) {
					let methods
					let properties

					// Create an DBusInterface object in the parent
					parent[name] = new DBusInterface2 (name)

					// Find all methods of this interface and...
					methods = iface.find ('method[@name]')

					//...create an actual Javascript function for each of them
					for (let method of methods) {
						let methodName = method.attr('name').value()
						let methodArgs = method.find('arg[@type][@direction="in"]') // Get method's arguments from introspection
						let signature = ''

						// Build the 'signature' field for the DBus method call message
						for (let methodArg of methodArgs) {
							signature += methodArg.attr('type').value()
						}

						// We have to use arrow function here, otherwise we would need to save the 'this' reference
						parent[name][methodName] = (...args) => {
							// Message to issue the method call when this function is called
							let msg = {
								destination: this.name,
								path,
								'interface': name,
								member: methodName,
								signature,
								body: args,
							} // 'type' is not set because it defaults to 'method_call'

							// Check that the number of arguments given correspond to the introspection
							if (methodArgs.length !== msg.body.length) {
								throw new TypeError ('Incorrect number of arguments passed to \'' + methodName + '\'')
							}

							// TODO can we parse the arguments and check them against the signature?

							/*
								Everything looks good, make the method and return the promise of the method call.
								It's the user's responsibility to use .then() and .catch() on this call.
							*/
							return Promise.promisify (this.bus.invoke)(msg)
						}
					}

					// Find all properties and...
					properties = iface.find ('property[@name]')

					//...create an actual property (getter/setter) depending on the 'access'
					for (let property of properties) {
						let propName = property.attr('name').value()
						let propType = property.attr('type').value()

						/*
							We want to provide synchronous access to property values. So in the introspection pass, we
							make actual GET calls to get the current properties value (to be able to return them
							immediately) and then we listen to the service's 'PropertiesChanged' signal to update the
							value.
							This way, when users of the library query the service for a property value, no DBus call
							(so no roundtrip) is made (wasted? ^^).
						*/

						// Create the DBus message to GET the property value
						let msg = {
							path,
							destination: this.name,
							'interface': 'org.freedesktop.DBus.Properties',
							member: 'Get',
							signature: 'ss',
							body: [
								name,
								propName,
							]
						}

						// Make the DBus call to ask for the property value
						allProperties.push (Promise.promisify (this.bus.invoke) (msg)
							.then( (ret) => {
								let propValue = signature.valueFromTree (ret)

								if (typeof propValue === 'undefined') {
									console.warn ('Could not get the value of property ' + propName + ' for unknown reason (mostly unsupported complex type). Please raise an issue on github!')
								} else {
 									/*
										To allow for synchronous, immediate access to properties, we store them in
										a separate field (prepended with '_').
										On GET queries, simply returns the value in this location.
										On SET queries, issue a DBus Set call and the listener for 'PropertiesChanged'
										will take care of updating the value inside this custom location
									*/
									// parent[name]['_' + propName] = propValue

									/*
										Define the accessor function for this property.
										If the function is called with no arguments, then it's a getter, if it's called
										with exactly one argument, then it's a getter, otherwise, it's an error
									*/
									parent[name][propName] = (...args) => {
										if (args.length === 0) {
											console.log ('GETTER ' + propName)
											// Getter: return the property value
											return Promise.resolve (propValue)
										}
										else if (args.length === 1) {
											console.log ('SETTER ' + propName)
											/*
												Setter: issue the DBus call to set the property value. Once we have the
												answer from DBus, if it's positive (the value was indeed set), emit the
												'PropertiesChanged' signal and then return the resolved promise to the
												caller.
											*/
											/*
												NOTE: it's not the place to emit the signal: do it in stdifaces.js!
											*/
											let msg = {
												path,
												destination: this.name,
												'interface': 'org.freedesktop.DBus.Properties',
												member: 'Set',
												signature: 'ssv',
												body: [
													name,
													propName,
													// Arg is passed as-is: user must properly format the param
													[propType, args[0]] // args[0] is valid: we checked for length === 1
												]
											}

											return Promise.promisify (this.bus.invoke) (msg)
											/*
											.then( () => {
												let signalBody = [
													name, // the interface name
													[[propName, [propType, args[0]]]], // the new properties
													[] // no invalidated properties
												]

												// Send the 'PropertiesChanged' signal (synchronous call)
												this.bus.sendSignal (
													path, // path of the object emitting the signal
													'org.freedesktop.DBus.Properties', // iface name of the signal
													'PropertiesChanged', // signal name
													'sa{sv}as',
													signalBody
												)

												return
											})
											.catch( (err) => {
												console.error ('ERROR IN EMIT SIGNAL SET:')
												console.error (err)
												console.error ('END OF ERROR')
												return Promise.reject (err)
											})
											*/
										}
										else {
											console.log ('NOTHING ' + propName)
											// Not getter nor setter: warn and fail
											let str = 'Called accessor \'' + propName + '\' function with more than 0 or 1 argument.'
											if (DEBUG) {
												console.warn (str)
											}
											return Promise.reject (new TypeError (str))
										}
									}

									// NOTE: we don't make properties real properties because we can't have an asynchronous setter. So we switched to the functional approach :/
									/*
									Object.defineProperty (parent[name], propName, {
										get: function() {
											return this['_' + propName]
										},
										set: function (value) {
											// this['_' + propName] = value
										}
									})
									//*/
								}
							})
							.catch( (err) => {
								console.error ('### propName: ' + propName)
								console.error ('### err: ' + err.stack)
							})
						)
					}
				} else {
					console.warn (`Ignored interface '${name}' because it is not a valid DBus interface name.`)
				}
			}

			//*
			// Then take care of the node: repeat this introspection function for the nodes
			for (let node of nodes) {
				//... get its name...
				let nodeName = node.attr('name').value()
				console.log ('Found node ' + nodeName)

				if (utils.isValidPathComponent (nodeName)) {
					let newPath

					//...and create a DBusObject, assigned this this key
					parent[nodeName] = new DBusObject2()

					newPath = path === '/'
					? path + nodeName
					: path + '/' + nodeName

					recursiveNodes.push (this.makeIntrospectionPass (newDepth, parent[nodeName], newPath))
				} else {
					console.warn (`Ignored node object '${nodeName}' because it is not a valid DBus path component.`)
				}
			}
			//*/

			// Wait that all properties are fetched and all recursived nodes are introspected
			return Promise.all (allProperties.concat (recursiveNodes))
			.then( () => {
				return
			})
		})
		.catch( (err) => {
			console.error ('Could not introspect service ' + this.name)
			console.error (err)
		})
	}
	// Means we reached the maximum introspection depth, so return
	else {
		console.log ('Reached maximum recursion depth!')
		return Promise.resolve ()
	}
}

module.exports = DBusService2

// module.exports = {
// 	DBusService2
// }
