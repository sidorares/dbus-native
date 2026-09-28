// `require('dbus-native')` leaves introspection's XML stack unloaded. xml2js
// and xmlbuilder were 11 ms of every require, most of what loading the
// package cost, and a bus that exports services and emits signals never
// needs them. The first `getObject` loads them; the broker's "works through
// the proxy API, introspection and all" is the test that it still does.

const { describe, it } = require('node:test');
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

describe('loading', () => {
  it('leaves the introspection XML parser for the first proxy', () => {
    // a process of its own: this one has loaded everything already
    const out = execFileSync(
      process.execPath,
      [path.join(__dirname, 'utils', 'loaded-xml.js')],
      { encoding: 'utf8' }
    );
    assert.deepStrictEqual(JSON.parse(out), []);
  });
});
