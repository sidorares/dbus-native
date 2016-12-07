'use strict';

const debug              = require ('debug')('dbus-native:DBusProxy')
const utils              = require ('./utils.js')
const Errors             = require ('./Errors.js')
const inspect            = require ('util').inspect
const Promise            = require ('bluebird')
const libxmljs           = require ('libxmljs')
const parseSignature     = require ('./signature.js')
const DBusObjectLibs     = require ('./DBusObjectLibs.js')
const DBusInterfaceLibs  = require ('./DBusInterfaceLibs.js')

const mandatory = utils.mandatory

const InvalidNameError = Errors.InvalidNameError

const DBusInterface = DBusInterfaceLibs.DBusInterface

const DBusObject = DBusObjectLibs.DBusObject

/** @module DBusProxy */

/**
 * Represents a remote DBus service.<br>
 * A DBusProxy has at least a service name (the well-known name on which it can be accessed on the bus).
 *
 * @param {string} serviceName The service name on which it can be accessed on the bus
 * @param {Object} bus         The bus (generally session or system) on which the service is exposed
 * @param {number} [maxIntrospectionDepth=Infinity] Maximum number of introspection recursion calls
 *
 * @throws {module:Errors#InvalidNameError}
 * @throws {TypeError}
 */
function DBusProxy (serviceName = mandatory(), bus = mandatory(), maxIntrospectionDepth = Infinity) {
	// Check if the service name respects the DBus naming convention and assign it if it does.
	if (!utils.isValidIfaceName (serviceName)) {
		throw new InvalidNameError (serviceName)
	}

	// Check if the max introsp. depth is valid (*ONLY IF* we build a proxy, otherwise this setting is ignored)
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
DBusProxy.prototype.makeIntrospectionPass = function (introspectionDepth, parent, path) {
	if (!isNaN (introspectionDepth) && introspectionDepth > 0) {
		let newDepth = introspectionDepth - 1
		let msg

		debug ('Introspecting \'' + path + '\'')

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
			debug ('Found ifaces: ' + ifaces.toString())

			//... and all nodes...
			nodes = doc.find ('node[@name]')
			debug ('Found nodes: ' + nodes.toString())

			//... and return them
			return {
				ifaces,
				nodes,
			}
		})
		.then( introspectData => {
			let ifaces = introspectData.ifaces
			let nodes = introspectData.nodes
			let recursiveNodes = []
			let getAllCalls = []
			// Interfaces on which it is unnecessary to call 'getAll()'
			let excludedInterfaces = [ 'org.freedesktop.DBus.Peer',
			                           'org.freedesktop.DBus.Properties',
									   'org.freedesktop.DBus.Introspectable',
									   'org.freedesktop.DBus.ObjectManager',
			                         ]

			// First deal with interfaces: if we found some, let's create DBusInterfaces
			for (let iface of ifaces) {
				let name = iface.attr('name').value()
				debug ('Found interface ' + name)

				if (utils.isValidIfaceName (name)) {
					let methods
					let properties
					let signals
					let getAll

					// Create an DBusInterface object in the parent
					parent[name] = new DBusInterface (name)

					// Find all methods of this interface and...
					methods = iface.find ('method[@name]')

					//...create an actual Javascript function for each of them
					for (let method of methods) {
						let methodName = method.attr('name').value()
						let methodArgs = method.find('arg[@type][@direction="in"]') // Get method's arguments from introspection
						let signature = ''
						let trees = []

						for (let methodArg of methodArgs) {
							let val = methodArg.attr('type').value()
							// Build the 'signature' field for the DBus method call message
							signature += val
							// Build the signature tree for the type conversion
							trees.push (parseSignature (val)[0])
						}

						// We have to use arrow function here, otherwise we would need to save the 'this' reference
						parent[name][methodName] = (...args) => {
							let translatedArgs = args.map( (v, idx) => utils.fromNewToOldAPI (v, trees[idx]))

							debug ('translatedArgs:\n' + inspect (translatedArgs, {depth: 5}))
							// Message to issue the method call when this function is called
							let msg = {
								destination: this.name,
								path,
								'interface': name,
								member: methodName,
								signature,
								body: translatedArgs,
								proxy: true // indicates that the call was made from a proxy (new API)
							} // 'type' is not set because it defaults to 'method_call'

							debug ('methodCall msg:\n' + inspect (msg, {depth: 4}))

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

					/*
						Make one call to 'GetAll()' to get all property values in one shot (much more efficient)
						But filter out standard properties (we _know_ there aren't any properties in these interfaces,
						so avoid wasting roundtrips and making additional, useless calls for them)
					*/
					if (!excludedInterfaces.includes (name)) {
						getAllCalls.push (Promise.promisify (this.bus.invoke) ({
							path,
							destination: this.name,
							'interface': 'org.freedesktop.DBus.Properties',
							member: 'GetAll',
							signature: 's',
							body: [name]
						})
						.then( ret => {
							let tree =  parseSignature ('a{sv}')[0]
							let convertedRet = utils.fromOldToNewAPI (ret, tree)
							return convertedRet
						})
						.then( allProperties => {
							/*
								Now that we have the value of all properties, we can create a getter and/or setter
								for each of them, based on the access mode
								NOTE: since we made a call to 'GetAll()' to get the property values, we don't have the values (nor keys) of the write-only properties. This is why we must loop through the
								'properties' field, which comes from the introspection and which, thus, include those
								write-only properties.
							*/

							for (let property of properties) {
								let propName = property.attr('name').value()
								let propAccess = property.attr('access').value()
								let propType = property.attr('type').value()
								let tree = parseSignature (propType)[0] // property -> one value so [0]

								// Don't try to store write-only property values since we don't have them
								if (propAccess !== 'write') {
									/*
										To allow for synchronous, immediate access to properties, we store them in
										a separate field (prepended with '_').
										On GET queries, simply returns the value in this location.
										On SET queries, issue a DBus Set call and the listener for 'PropertiesChanged'
										will take care of updating the value inside this custom location.

										We convert the property value in the new API format before storing them.
									*/
									parent[name]['_' + propName] = allProperties[propName]
								}
								
								/*
									Define the accessor function for this property.
									If the function is called with no arguments, then it's a getter.
									If it's called with exactly one argument, then it's a setter
									Otherwise, it's an error, so insult the user ^^
								*/
								parent[name][propName] = (...args) => {
									if (args.length === 0) {
										debug (`Get '${propName}'`)

										// Getter: return the property value if it is readable
										if (['read', 'readwrite'].includes (propAccess))
											return Promise.resolve (parent[name]['_' + propName])
										else
											return Promise.reject (new Error ('org.freedesktop.DBus.Error.PropertyWriteOnly'))
									}
									else if (args.length === 1) {
										debug (`Set '${propName}'`)

										// Issue the Set call, if the property is writable
										if (['readwrite', 'write'].includes (propAccess)) {
											// Translate the new API format, user-supplied to old API for marshalling
											let translatedPropValue = utils.fromNewToOldAPI (args[0], tree)

											/*
											This is CORRECT: we wrap the value in an additionnal level of array nesting If the
											value is already an array. This is the expected behavior: if it's already an array, it
											means it's a container type (which must be wrapper in a level of array nesting to be marshalled).
											If it's not (a single type value), then there should not be more nesting
											*/
											if (Array.isArray (translatedPropValue))
												translatedPropValue = [translatedPropValue]

											/*
												Setter: issue the DBus call to set the property value and return the (empty)
												promise to the caller when the set is done.
												Normally, the targeted service should emit a 'PropertiesChanges' signal when
												we set a new value to the property and this library is configured to
												automatically listen for this signal and update the value, so the next time
												the user calls GET on this property, it SHOULD have the new value.
												NOTE: we DELIBERATELY NOT update the value here, in this setter, because
												that would introduce an inconsistency between the state of the real
												DBus service and the state of this proxy which is supposed to represent
												it. So we chose to issue the SET call to the DBus service and wait for
												the 'PropertiesChanges' to update the actual value.
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
													[propType, translatedPropValue]
												]
											}

											return Promise.promisify (this.bus.invoke) (msg)
										}
										else // the property is read-only
											return Promise.reject ( new Error ('org.freedesktop.DBus.Error.PropertyReadOnly'))
									}
									// The accessor function was called with more than 1 argument
									else {
										debug (`Wrong accessor for '${propName}'`)

										// Neither getter nor setter: warn and fail
										let str = `Called accessor '${propName}' function with more than 0 or 1 argument.`

										debug (str)

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
						})) // second parenthese is the closing parenthese of 'getAllCalls.push()'
					}

					// Find all signals and...
					signals = iface.find ('signal[@name]')

					//... make the interface listen for them and emit (Javascript) signals when they occur
					for (let signal of signals) {
						let signalName = signal.attr('name').value()
						let matchRule = "type='signal',path='" + path + "',interface='" + name + "',member='" + signalName + "'"

						debug (`Adding matchRule: ${matchRule}`)

						// Add the match rule on the bus so that the DBus daemon sends us the signals
						Promise.promisify (this.bus.addMatch) (matchRule)
						.then( () => {
							// Compute mangled signal name which the bus will emit (to uniquely identify the signal)
							let mangledSignalName = this.bus.mangle (path, name, signalName)

							// Listen for the signal, and re-emit it from the correct DBusInterface
							this.bus.signals.on (mangledSignalName, (msg, signature_) => {
								let trees = parseSignature (signature_)

								debug ('DBusProxy: Caught bus.signal emitting mangled: "' + mangledSignalName + '"\nRe-emitting Javascript event: "' + signalName + '"')

								let translatedArgs = msg.map( (v, idx) => utils.fromOldToNewAPI (v, trees[idx]))

								debug ('translatedArgs:\n' + inspect (translatedArgs, {depth: 5}))

								/*
									Listen for the 'PropertiesChanged' signal and change properties accordingly.
									We do not use the standard on('PropertiesChanged') because if the user, at some points, decides to listen for this signal, and then decides to use `removeAllListeners()` on it, he will lose the update of the properties.
									We deal with PropertiesChanged before re-emitting the signal as a Javascript signal
									so that, by the time the user catches and acts upon it, modifications are already
									propagated to the proxy object.
								*/
								if (signalName === 'PropertiesChanged') {
									let ifaceName = translatedArgs[0]
									let changedProperties = translatedArgs[1]
									// Not sure what this is used for
									// let invalidatedProperties = translatedArgs[2]

									// To be sure we have the requested fields
									if (ifaceName === undefined || changedProperties === undefined) {
										let errStr = `Error: Malformed or badly-parsed 'ChangedProperties' payload!`
										console.error (errStr)
									} else {
										// Make sure we do have an interface by that name on the obj
										if (parent[ifaceName] === undefined) {
											let errStr = `Error: no interface '${ifaceName}' to act on 'PropertiesChanged'`
											console.error (errStr)
										} else {
											for (let changedProperty of Object.keys (changedProperties)) {
												/*
													Make sure we have a property by that name, which is managed by the
													proxy.
													TODO: check the introspection data for the property name AND access
													      mode. Because right now, it is possible to forge a
														  'PropertiesChanged' signall with custom-made fields to bypass
														  the access mode that is checked by the Proxy Getter / Setter
														  AND it's possible to forge the message to changed an internal
														  field which begins with an underscore.
												*/
												if (parent[ifaceName]['_' + changedProperty] === undefined) {
													let errStr = `Error: interface '${ifaceName}' doesn't have a property '${changedProperty}'; dropping 'PropertiesChanged'.`
													console.error (errStr)
												} else {
													// Change the property value
													parent[ifaceName]['_' + changedProperty] = changedProperties[changedProperty]
												}
											}
										}
									}
								}

								/*
									We use the spread operator here, here's why:
									- if there is only one argument, then 'translatedArgs' is an array with one
									  element. the spread operator will then take this element and apply it, as if
									  we have applied 'translatedArgs[0]'
									- if there are several elements, then the spread operator will apply each
									  element and in the receiving function, we can catch each individual element
								*/
								parent[name].emit (signalName, ...translatedArgs)
							})
						})
					}
				} else {
					console.warn (`Ignored interface '${name}' because it is not a valid DBus interface name.`)
				}
			}

			// Then take care of the node: repeat this introspection function for the nodes
			for (let node of nodes) {
				//... get its name...
				let nodeName = node.attr('name').value()
				debug ('Found node ' + nodeName)

				if (utils.isValidPathComponent (nodeName)) {
					let newPath

					//...and create a DBusObject, assigned this this key
					parent[nodeName] = new DBusObject()

					newPath = path === '/'
					? path + nodeName
					: path + '/' + nodeName

					recursiveNodes.push (this.makeIntrospectionPass (newDepth, parent[nodeName], newPath))
				} else {
					console.warn (`Ignored node object '${nodeName}' because it is not a valid DBus path component.`)
				}
			}

			// Wait that all properties are fetched and all recursived nodes are introspected
			return Promise.all (getAllCalls.concat (recursiveNodes))
			.return () // replaces an empty .then( () => return )
		})
		.catch( err => {
			console.error (`Could not introspect object '${path}' of service '${this.name}'`)
			console.error (err)
		})
	}
	// Means we reached the maximum introspection depth, so return
	else {
		debug ('Reached maximum recursion depth!')
		return Promise.resolve ()
	}
}

module.exports = DBusProxy
