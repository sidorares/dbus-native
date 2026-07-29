// Runs the Docker end-to-end checks with the spec reporter.
//
// Deliberately not wired into `npm test`: these need a Linux box with a
// desktop bus, and they are a checkpoint rather than a gate. See
// E2E_DOCKER_TESTING.md.

const { run } = require('node:test');
const { spec } = require('node:test/reporters');
const path = require('path');
const fs = require('fs');

const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter(f => /^\d\d-.*\.js$/.test(f))
  .sort()
  .map(f => path.join(dir, f));

console.log(`running ${files.length} end-to-end files\n`);

let failed = 0;
run({ files, concurrency: 1, timeout: 180000 })
  .on('test:fail', () => failed++)
  .compose(spec)
  .pipe(process.stdout)
  .on('finish', () => process.exit(failed ? 1 : 0));
