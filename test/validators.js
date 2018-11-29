const assert = require('assert');
const {
  isObjectPathValid,
  isInterfaceNameValid,
  isMemberNameValid
} = require('../lib/validators');

let validPaths = ['/', '/foo', '/foo/bar', '/foo/bar/bat'];
for (let path of validPaths) {
  assert.ok(isObjectPathValid(path));
}

let invalidPaths = [
  undefined,
  {},
  '',
  'foo',
  'foo/bar',
  '/foo/bar/',
  '/$/foo/bar',
  '/foo//bar',
  '/foo$bar/baz'
];
for (let path of invalidPaths) {
  assert.ok(!isObjectPathValid(path));
}

let validNames = ['foo.bar', 'foo.bar.bat', '_foo._bar', 'foo.bar69'];
for (let name of validNames) {
  assert.ok(isInterfaceNameValid(name));
}

let invalidNames = [
  undefined,
  {},
  '',
  '5foo.bar',
  'foo.6bar',
  '.foo.bar',
  'bar..baz',
  '$foo.bar',
  'foo$.ba$r'
];
for (let name of invalidNames) {
  assert.ok(!isInterfaceNameValid(name));
}

let validMembers = ['foo', 'FooBar', 'Bat_Baz69'];
for (let member of validMembers) {
  assert.ok(isMemberNameValid(member));
}

let invalidMembers = [undefined, {}, '', 'foo.bar', '5foo', 'foo$bar'];
for (let member of invalidMembers) {
  assert.ok(!isMemberNameValid(member));
}
