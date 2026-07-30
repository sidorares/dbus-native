// The unixexec: transport, which runs the bus as a child process and talks to
// it over its stdio.
//
// https://dbus.freedesktop.org/doc/dbus-specification.html#transports-exec
//
// The keys are `argv0` and `argv1`, `argv2`, ... Up to 0.14.0 this read `arg1`,
// `arg2`, ... which no address generator produces, so every argument on a
// conformant address was silently dropped and the binary ran bare.

const { describe, it } = require('node:test');
const assert = require('assert');
const { connectToAddress, unixexecArgs } = require('../lib/address');

/**
 * Everything the child writes on stdout.
 *
 * These children print and exit immediately, which can tear the duplex down
 * before its writable half has anything to flush. What is under test is the
 * argument vector the child saw, so that race is not interesting here.
 */
const readAll = stream =>
  new Promise((resolve, reject) => {
    const chunks = [];
    const done = () => resolve(Buffer.concat(chunks).toString());
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', done);
    stream.on('error', err =>
      err.code === 'ERR_STREAM_PREMATURE_CLOSE' ? done() : reject(err)
    );
  });

describe('unixexec: argument vectors', () => {
  it('takes its arguments from argv1 onwards', () => {
    assert.deepStrictEqual(unixexecArgs({ argv1: 'a', argv2: 'b' }), [
      'a',
      'b'
    ]);
  });

  it('leaves argv0 out -- it is the program name, not an argument', () => {
    assert.deepStrictEqual(unixexecArgs({ argv0: 'zero', argv1: 'a' }), ['a']);
  });

  it('stops at the first gap, as the spec requires', () => {
    // "If a specific argvX is not specified no further argvY for Y > X are
    // taken into account."
    assert.deepStrictEqual(unixexecArgs({ argv1: 'a', argv3: 'c' }), ['a']);
  });

  it('keeps an empty argument rather than ending the list on it', () => {
    assert.deepStrictEqual(unixexecArgs({ argv1: '', argv2: 'b' }), ['', 'b']);
  });

  it('ignores the arg1/arg2 keys this read before 0.15', () => {
    // Regression guard: they are not spec keys, and reading them was the bug.
    assert.deepStrictEqual(unixexecArgs({ arg1: 'a', arg2: 'b' }), []);
  });

  it('passes no arguments when there are none', () => {
    assert.deepStrictEqual(unixexecArgs({ path: '/bin/echo' }), []);
  });
});

describe('unixexec: the child process', () => {
  it('really does get the arguments', async () => {
    const stream = connectToAddress(
      'unixexec:path=/bin/echo,argv1=hello,argv2=world'
    );
    // Before the fix this was '\n' -- echo ran with no arguments at all.
    assert.strictEqual(await readAll(stream), 'hello world\n');
  });

  it('runs under the program name argv0 asks for', async () => {
    const stream = connectToAddress(
      `unixexec:path=${process.execPath},argv0=pretend-name,argv1=-p,argv2=process.argv0`
    );
    assert.strictEqual((await readAll(stream)).trim(), 'pretend-name');
  });

  it('defaults the program name to path when argv0 is absent', async () => {
    const stream = connectToAddress(
      `unixexec:path=${process.execPath},argv1=-p,argv2=process.argv0`
    );
    assert.strictEqual((await readAll(stream)).trim(), process.execPath);
  });

  it('says what is missing when there is no path', () => {
    assert.throws(() => connectToAddress('unixexec:argv1=hello'), {
      message: /not enough parameters for 'unixexec' connection/
    });
  });
});
