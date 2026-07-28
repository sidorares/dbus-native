// Deprecation warnings, following Node's own convention: a stable code per
// deprecation, warned once per process, with a documentation anchor.
//
// The code matters more than the message. `node --throw-deprecation` turns
// these into thrown errors, so a consumer can find every affected call site in
// their own codebase by running their test suite.

const DOCS =
  'https://github.com/sidorares/dbus-native/blob/master/docs/deprecations.md';

const warned = new Set();

function deprecate(code, message) {
  if (warned.has(code)) return;
  warned.add(code);
  process.emitWarning(`${message} See ${DOCS}#${code.toLowerCase()}`, {
    type: 'DeprecationWarning',
    code
  });
}

// Exposed for tests, which need each case to warn in isolation.
deprecate.reset = () => warned.clear();

module.exports = deprecate;
