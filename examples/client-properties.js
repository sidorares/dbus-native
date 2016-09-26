'use strict';

const dbus = require ('../index.js')

/*
	This example shows how to query a DBus service for its properties (no methods nor signals here), get their value (
	and display them) and then change them.
	Since we're acting only as a client, there is not need to request a name: we don't need to register a service
	against the bus (but we could!), so we only act as a client.

	NOTE: this file is made to query the service that is exposed in the file 'server-properties.js', so be sure to
	start it first (node server-properties.js in another terminal should be enough)
)
*/

// This is the DBus service we will query (server-properties.js)
const targetServiceName   = 'com.dbus.native.properties'

// This is the service's interface we will query
const targetIfaceName = targetServiceName // note that is it equal to the service name, but this is not mandatory at all

// This is the service's DBus object path that we will query for the properties
const targetObjectPath    = '/' + targetServiceName.replace (/\./g, '/')

// First, connect to the session bus (works the same on the system bus, it's just less permissive)
const sessionBus = dbus.sessionBus()

// Check the connection was successful
if (!sessionBus) {
	throw new Error ('Could not connect to the DBus session bus.')
}

// First, we must query the bus for the desired DBus service:
let targetService = sessionBus.getService (targetServiceName)

// Then we must query it's interface, this is callback-based
targetService.getInterface (targetObjectPath, targetIfaceName, (e, iface) => {
	// we need to check for error
	if (e || !iface) {
		console.error ('Could not query interface \'' + targetIfaceName + '\', the error was: ' + err ? err : '(no error)')
		process.exit (1)
	}

	/*
		Now, the service's object's interface is represented in 'iface'.
		Properties are accessed via callback (so it can be a bit verbose)
	*/
	iface.SingleString ((e, propValue) => {
		// Be careful not to check for `! propValue` because, what if propValue is a boolean whose value is false?!
		if (e || typeof propValue === 'undefined') {
			console.error ('Could not get propery \'SingleString\', the error was: ' + err ? err : '(no error)')
			process.exit (1)
		}

		// now it's safe: we can display the value
		console.log ('SingleString: ' + propValue)

		/*
			Move to the next example (you can comment the line if you want to go step-by-step)
			Also, since this is all callback-based, I'm nesting the 'stepX' calls so that what is displayed on your
			console is in the same order as the calls here. But in YOUR applications you can do otherwise of course.
		*/
		step1()
	})

	// Show how to get and change the value of 'SingleInt32'
	function step1() {
		iface.SingleInt32 ((e, propValue) => {
			// Be careful not to check for `! propValue` because, what if propValue is a boolean whose value is false?!
			if (e || typeof propValue === 'undefined') {
				console.error ('Could not get propery \'SingleInt32\', the error was: ' + err ? err : '(no error)')
				process.exit (1)
			}

			console.log ('SingleInt32 (before change): ' + propValue)

			// Changing a property value is a simple matter of assignment:
			iface.SingleInt32 = 33

			/*
			Let's display it again (you will notice that this callback-based accessor is verbose, I advise to make
			a helper that automatically checks for error)
			*/
			iface.SingleInt32 ((e, propValue) => {
				// Be careful not to check for `! propValue` because, what if propValue is a boolean whose value is false?!
				if (e || typeof propValue === 'undefined') {
					console.error ('Could not get propery \'SingleInt32\', the error was: ' + err ? err : '(no error)')
					process.exit (1)
				}

				console.log ('SingleInt32 (after change): ' + propValue)

				/*
					Move to the next example (you can comment the line if you want to go step-by-step)
					Also, since this is all callback-based, I'm nesting the 'stepX' calls so that what is displayed on your
					console is in the same order as the calls here. But in YOUR applications you can do otherwise of course.
				*/
				step2()
			})
		})
	}

	function step2() {
		iface.ArrayOfUint16 ((e, propValue) => {
			// Be careful not to check for `! propValue` because, what if propValue is a boolean whose value is false?!
			if (e || typeof propValue === 'undefined') {
				console.error ('Could not get propery \'ArrayOfUint16\', the error was: ' + err ? err : '(no error)')
				process.exit (1)
			}

			console.log ('ArrayOfUint16 (before change): ' + propValue)

			/*
				Remember our typing convention here: since an array is a "complex / container" type, it must be enclosed
				in brackets; that's the first (outer) pair. Then, the second (inner) pair of brackets is the actual
				array.
				Please see comments in 'service-properties.js' for more information on this.
			*/
			iface.ArrayOfUint16 = [[20,21,21,22]]

			/*
			Let's display it again (you will notice that this callback-based accessor is verbose, I advise to make
			a helper that automatically checks for error)
			*/
			iface.ArrayOfUint16 ((e, propValue) => {
				// Be careful not to check for `! propValue` because, what if propValue is a boolean whose value is false?!
				if (e || typeof propValue === 'undefined') {
					console.error ('Could not get propery \'ArrayOfUint16\', the error was: ' + err ? err : '(no error)')
					process.exit (1)
				}

				console.log ('ArrayOfUint16 (after change): ' + propValue)

				/*
					Move to the next example (you can comment the line if you want to go step-by-step)
					Also, since this is all callback-based, I'm nesting the 'stepX' calls so that what is displayed on your
					console is in the same order as the calls here. But in YOUR applications you can do otherwise of course.
				*/

			})
		})
	}
})
