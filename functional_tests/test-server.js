/**
 * Test basic server
 */
var dbus = require("../index.js");
var assert     = require('assert');
var Q = require("q");

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

    function launchService(bus, name, path, interfaceName, implementation)  {
        var deferred = Q.defer();
        bus.requestName(name, 0);
        bus.exportInterface(implementation, path, interfaceName);
        deferred.resolve();
        return deferred.promise;
    }

    function invokeService(bus, testInvocation) {
        var deferred = Q.defer();
        bus.invoke(testInvocation, function (err, res) {
            if(err)
            {
                deferred.reject(err);
            } else {
                deferred.resolve(res);
            }
        });
        return deferred.promise;
    }

    it("serves a basic service", function(done) {
        //don't run if not on local machine
        if(process.env.CI) {
            return;
        }
        var testInvocation = {
            path: testPath,
            destination: testName,
            interface: testInterfaceName,
            member: 'multiplyByTwo',
            signature: 'y',
            body: [2]
        };
        launchService(bus, testName, testPath, testInterface, testImplementation )
            .then(function() { return invokeService(bus, testInvocation);})
            .then(function(result){
                assert.equal(result, 4);
                done();
            })
            .catch(function(err) {
                throw new Error(err);
            })
            .done();
    });

    it("serves a basic service, uses different method on same service", function(done) {
        //don't run if not on local machine
        if(process.env.CI) {
            return;
        }
        var a = 2;
        var b = 5;
        var testInvocation = {
            path: testPath,
            destination: testName,
            interface: testInterfaceName,
            member: 'addTwoNumbers',
            signature: 'yy',
            body: [a, b]
        };
        launchService(bus, testName, testPath, testInterface, testImplementation )
            .then(function() { return invokeService(bus, testInvocation);})
            .then(function(result){
                assert.equal(result, a + b);
                done();
            })
            .catch(function(err) {
                throw new Error(err);
            })
            .done();
    });
});
