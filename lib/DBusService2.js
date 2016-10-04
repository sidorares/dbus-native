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
const DEBUG_THIS_FILE = false

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
			let doc
			let ifaces
			let nodes

			// Parse the XML introspection data
			doc = libxmljs.parseXml (xml)

			// Find all interfaces...
			ifaces = doc.find ('interface[@name]')
			if (DEBUG) console.log ('Found ifaces: ' + ifaces.toString())

			//... and all nodes...
			nodes = doc.find ('node[@name]')
			if (DEBUG) console.log ('Found nodes: ' + nodes.toString())

			//... and return them
			return {
				ifaces,
				nodes,
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
					let signals

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

						/*
							Make the DBus call to ask for the property value
							NOTE: since GETting a property is actually making a DBus call, i can take time and there is
							no reason that the rest of the code waits for them. So we effectively 'push' all the
							promisifed DBus calls into 'allProperties' so that we cna continue defining the accessors,
							etc.
							Obviously at the end we need to wait for all the property values to be indeed fetched before
							returning the service, so the waiting is done at this moment only with 'Promise.all()'
						*/
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
									parent[name]['_' + propName] = propValue
								}
							})
						)

						/*
							Define the accessor function for this property.
							If the function is called with no arguments, then it's a getter.
							If it's called with exactly one argument, then it's a setter
							Otherwise, it's an error, so insult the user ^^
						*/
						parent[name][propName] = (...args) => {
							if (args.length === 0) {
								if (DEBUG) console.log ('GETTER ' + propName)
								// Getter: return the property value
								return Promise.resolve (parent[name]['_' + propName])
							}
							else if (args.length === 1) {
								if (DEBUG) console.log ('SETTER ' + propName)
								/*
									Setter: issue the DBus call to set the property value and return the (empty)
									promise to the caller when the set is done.
									Normally, the targeted service should emit a 'PropertiesChanges' signal when
									we set a new value to the property and this library is configured to
									automatically listen for this signal and update the value, so the next time the
									user calls GET on this property, it SHOULD have the new value.
									NOTE: we DELIBERATELY NOT update the value here, in this setter, because that
									would introduce an inconsistency between the state of the real DBus service and
									the state of this proxy which is supposed to represent it. So we chose to issue
									the SET call to the DBus service and wait for the 'PropertiesChanges' to update
									the actual value.
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
							}
							else {
								if (DEBUG) console.log ('NOTHING ' + propName)
								// Not getter nor setter: warn and fail
								let str = 'Called accessor \'' + propName + '\' function with more than 0 or 1 argument.'
								if (DEBUG) {
									console.warn (str)
								}
								return Promise.reject (new TypeError (str))
							}
						}

						/*
							TODO: maybe we want to define and explicit 'getProperty(<property-name>)' function that
							would make the DBus call to GET the property on demand. This is to complement the
							abovementionned mechanism to cope with DBus services which are poorly-implemented and
							which DO NOT emit the 'PropertiesChanged' signal when some of their properties are
							changed.
						*/
					}

					// Find all signals and...
					signals = iface.find ('signal[@name]')

					//... make the interface listen for them and emit (Javascript) signals when they occur
					for (let signal of signals) {
						let signalName = signal.attr('name').value()
						let matchRule = "type='signal',path='" + path + "',interface='" + name + "',member='" + signalName + "'"

						/*
							NOTE: Do we need to treat 'PropertiesChanged' differently?
							I don't think so: what if people want to act on it too?
							The best case is to ismply re-emit it as usual and SEPARATELY set the DBusInterface2 to listen for it.
							TODO: check if that works
						*/

						// Add the match rule on the bus so that the DBus daemon sends us the signals
						Promise.promisify (this.bus.addMatch) (matchRule)
						.then( () => {
							// Compute mangled signal name which the bus will emit (to uniquely identify the signal)
							let mangledSignalName = this.bus.mangle (path, name, signalName)

							// Listen for the signal, and re-emit it from the correct DBusInterface
							this.bus.signals.on (mangledSignalName, (msg) => {
								parent[name].emit (signalName, msg)
							})
						})
					}

					// Make the Javascript interface listen for the 'PropertiesChanged' and change property value accordingly
					parent[name].on ('PropertiesChanged', (msg) => {
						let ifaceName = msg[0]
						let changedProperties = msg[1]

						for (let changedProperty of changedProperties) {
							let newPropValue = signature.valueFromTree (changedProperty[1])
							let propName = changedProperty[0]

							if (typeof newPropValue !== 'undefined') {
								parent[ifaceName]['_' + propName] = newPropValue
							}
						}
					})

				} else {
					console.warn (`Ignored interface '${name}' because it is not a valid DBus interface name.`)
				}
			}

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
