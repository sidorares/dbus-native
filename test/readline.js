// readOneLine backs the SASL handshake, so it has to cope with lines split
// across chunks and must leave the remainder of a chunk readable.

const assert = require('assert');
const { PassThrough } = require('stream');
const readOneLine = require('../lib/readline');

const line = stream =>
  new Promise(resolve => readOneLine(stream, buf => resolve(buf.toString())));

describe('readOneLine', () => {
  it('reads a line delivered in one chunk', async () => {
    const s = new PassThrough();
    const p = line(s);
    s.write('OK 1234\n');
    assert.strictEqual(await p, 'OK 1234');
  });

  it('reads a line split across several chunks', async () => {
    const s = new PassThrough();
    const p = line(s);
    s.write('OK ');
    s.write('12');
    s.write('34\n');
    assert.strictEqual(await p, 'OK 1234');
  });

  it('splits one chunk into consecutive lines', async () => {
    const s = new PassThrough();
    const first = line(s);
    s.write('REJECTED EXTERNAL\nOK abcdef\nDATA\n');
    assert.strictEqual(await first, 'REJECTED EXTERNAL');
    assert.strictEqual(await line(s), 'OK abcdef');
    assert.strictEqual(await line(s), 'DATA');
  });

  it('leaves bytes after the newline on the stream', async () => {
    const s = new PassThrough();
    const p = line(s);
    s.write('OK 1234\r\nBINARYPAYLOAD');
    assert.strictEqual(await p, 'OK 1234\r');
    await new Promise(setImmediate);
    assert.strictEqual(s.read().toString(), 'BINARYPAYLOAD');
  });

  it('handles an empty line', async () => {
    const s = new PassThrough();
    const p = line(s);
    s.write('\nrest\n');
    assert.strictEqual(await p, '');
    assert.strictEqual(await line(s), 'rest');
  });

  it('handles a newline arriving in its own chunk', async () => {
    const s = new PassThrough();
    const p = line(s);
    s.write('AUTH EXTERNAL');
    s.write('\n');
    assert.strictEqual(await p, 'AUTH EXTERNAL');
  });

  it('reports a throwing callback on the stream', done => {
    const s = new PassThrough();
    s.on('error', err => {
      assert.strictEqual(err.message, 'boom');
      done();
    });
    readOneLine(s, () => {
      throw new Error('boom');
    });
    s.write('line\n');
  });

  it('does not consume anything before a newline arrives', async () => {
    const s = new PassThrough();
    let called = false;
    readOneLine(s, () => {
      called = true;
    });
    s.write('no newline yet');
    await new Promise(setImmediate);
    assert.strictEqual(called, false);
  });
});
