/**
 * Test basic dbus service
 */
var dbus    = require("../index.js");
var assert  = require('assert');

// test locally atm, requires running dbus daemon.
// TODO: start daemon on travis or mock daemon
if(process.env.CI)
    return;

describe("server", function() {

    var testPath = "/com/nodedbustest/service";
    var testName = "com.nodedbustest.service";
    var testInterfaceName = "com.nodedbustest.service";
    var bus = dbus.sessionBus();

    var testInterface = {
        name: testInterfaceName,
        methods: {
            multiplyByTwo: ['y', 'y'],
            addTwoNumbers: ['yy', 'y']
        }
    };

    var testImplementation = {
        multiplyByTwo: function(a) {
            return 2 * a;
        },
        addTwoNumbers: function(a, b) {
            return a + b;
        }
    };

    before(function()  {
        bus.requestName(testName, 0);
        bus.exportInterface(testImplementation, testPath, testInterfaceName);
    });

    after(function() {
        bus.connection.end();
    });

    it("serves a basic service", function(done) {
        //don't run if not on local machine
        bus.invoke({
            path: testPath,
            destination: testName,
            interface: testInterfaceName,
            member: 'multiplyByTwo',
            signature: 'y',
            body: [2]
        }, function(err, result) {
            assert.ifError(err);
            assert.equal(result, 4);
            done();
        });
    });

    it("serves a basic service, uses different method on same service", function(done) {
        var a = 2;
        var b = 5;
        bus.invoke({
            path: testPath,
            destination: testName,
            interface: testInterfaceName,
            member: 'addTwoNumbers',
            signature: 'yy',
            body: [a, b]
        }, function(err, result) {
            assert.ifError(err);
            assert.equal(result, a + b);
            done();
        });
    });
});
