// readOneLine backs the SASL handshake, so it has to cope with lines split
// across chunks and must leave the remainder of a chunk readable.

const { describe, it } = require('node:test');
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

  // Everything above either puts its lines in one write -- which the unshift
  // path covers -- or starts the next read from a promise continuation, by
  // which time the stream is no longer mid-emit.
  //
  // A SASL conversation does neither. It starts the next read *synchronously*
  // from the callback of the last one, which runs inside the 'readable'
  // emission. Attaching a listener there cannot schedule another emit, and
  // read() only ever hands back one buffered chunk, so a peer that wrote its
  // lines separately leaves the rest queued and the exchange stops dead.
  //
  // Chained with a helper rather than `await` on purpose: awaiting is what
  // hides it.
  const chain = (stream, count) =>
    new Promise(resolve => {
      const got = [];
      const step = () =>
        readOneLine(stream, buf => {
          got.push(buf.toString());
          if (got.length === count) return resolve(got);
          step();
        });
      step();
    });

  it('reads on when each line came in its own write', async () => {
    const s = new PassThrough();
    const all = chain(s, 3);
    s.write('one\n');
    s.write('two\n');
    s.write('three\n');
    assert.deepStrictEqual(await all, ['one', 'two', 'three']);
  });

  it('reads on when the lines were written before anyone was reading', async () => {
    const s = new PassThrough();
    s.write('early\n');
    s.write('bird\n');
    await new Promise(setImmediate);
    assert.deepStrictEqual(await chain(s, 2), ['early', 'bird']);
  });

  it('reads on when a line is split across writes after the first', async () => {
    const s = new PassThrough();
    const all = chain(s, 2);
    s.write('AUTH\n');
    s.write('EXTER');
    s.write('NAL\n');
    assert.deepStrictEqual(await all, ['AUTH', 'EXTERNAL']);
  });

  it('reports a throwing callback on the stream', (t, done) => {
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
