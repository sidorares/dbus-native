// Prints which of introspection's XML modules `require('dbus-native')` loaded,
// for test/lazy-load.js, which needs a process that has loaded nothing else.
require('../..');
const loaded = Object.keys(require.cache).filter(file =>
  file.split(/[\\/]/).some(part => part === 'xml2js' || part === 'xmlbuilder')
);
process.stdout.write(JSON.stringify(loaded));
