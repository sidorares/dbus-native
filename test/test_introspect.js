const introspect = require('../lib/introspect');
const fs = require('fs');
const path = require('path');

// Introspection test cases
const testCases = [{ desc: 'Basic Example', file: 'example' }];

describe('given introspect xml', () => {
  for (let i = 0; i < testCases.length; ++i) {
    const curTest = testCases[i];
    it(`should correctly process ${curTest.desc}`, () => {
      return testXml(curTest.file);
    });
  }
});

const dummyObj = {};
function testXml(fname) {
  const fpath = path.join(__dirname, 'fixtures', 'introspection', fname);
  return new Promise((resolve, reject) => {
    // get expected data from json file
    fs.readFile(`${fpath}.json`, 'utf8', (err, data) => {
      if (err) reject(err);
      const test_obj = JSON.parse(data);
      // get introspect xml from xml file
      fs.readFile(`${fpath}.xml`, (err, xml_data) => {
        if (err) reject(err);
        else {
          introspect.processXML(
            err,
            xml_data,
            dummyObj,
            (err, proxy, nodes) => {
              if (err) reject(err);
              else {
                checkIntrospection(test_obj, proxy, nodes);
                resolve();
              }
            }
          );
        }
      });
    });
  });
}

/*eslint no-unused-vars: ["error", { "argsIgnorePattern": "^_" }]*/
function checkIntrospection(test_obj, proxy, _nodes) {
  for (let i = 0; i < test_obj.interfaces.length; ++i) {
    const testInterface = test_obj.interfaces[i];
    if (proxy[testInterface.name] === undefined)
      throw new Error(
        `Failed to introspect interface name ${testInterface.name}`
      );
    for (let m = 0; m < testInterface.methods.length; ++m) {
      const methodName = testInterface.methods[m].name;
      const curMethod = proxy[testInterface.name].$methods[methodName];
      if (curMethod === undefined)
        throw new Error(
          `Failed to introspect method name ${methodName} of ${
            testInterface.name
          }`
        );
      if (curMethod !== testInterface.methods[m].signature)
        throw new Error(
          `Failed to introspect method args of ${methodName} of ${
            testInterface.name
          }`
        );
    }
    for (let p = 0; p < testInterface.properties.length; ++p) {
      const propName = testInterface.properties[p].name;
      const curProp = proxy[testInterface.name].$properties[propName];
      if (curProp === undefined)
        throw new Error(
          `Failed to introspect property name ${propName} of ${
            testInterface.name
          }`
        );
      if (curProp.type !== testInterface.properties[p].type)
        throw new Error(
          `Failed to introspect property type of ${propName} of ${
            testInterface.name
          }`
        );
    }
  }
}
