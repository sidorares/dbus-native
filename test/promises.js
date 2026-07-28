const assert = require('assert');
const { execFileSync } = require('child_process');
const { maybePromise } = require('../lib/promisify');
const { DBusError, toDBusError } = require('../lib/errors');

// Stand-in for an operation that calls back asynchronously. Returns undefined,
// like the real ones do.
const op =
  (err, ...values) =>
  cb => {
    setImmediate(() => cb(err, ...values));
  };

describe('maybePromise', () => {
  it('uses the callback when one is given, and returns nothing new', done => {
    const ret = maybePromise(
      (err, value) => {
        assert.strictEqual(err, null);
        assert.strictEqual(value, 42);
        done();
      },
      op(null, 42)
    );
    assert.strictEqual(ret, undefined);
  });

  it('resolves with the single value when no callback is given', async () => {
    assert.strictEqual(await maybePromise(undefined, op(null, 42)), 42);
  });

  it('resolves with undefined when the reply carries no values', async () => {
    assert.strictEqual(await maybePromise(undefined, op(null)), undefined);
  });

  it('resolves with an array when the reply carries several values', async () => {
    assert.deepStrictEqual(
      await maybePromise(undefined, op(null, 1, 2, 3)),
      [1, 2, 3]
    );
  });

  it('rejects with a DBusError', async () => {
    const body = Object.assign(['boom'], {
      message: 'boom',
      dbusName: 'com.example.Error.Boom'
    });
    await assert.rejects(
      () => maybePromise(undefined, op(body)),
      err => {
        assert.ok(err instanceof DBusError);
        assert.ok(err instanceof Error);
        assert.strictEqual(err.message, 'boom');
        assert.strictEqual(err.dbusName, 'com.example.Error.Boom');
        assert.deepStrictEqual(err.body, ['boom']);
        return true;
      }
    );
  });

  it('works when awaited after the call already completed', async () => {
    const pending = maybePromise(undefined, op(null, 'late'));
    await new Promise(setImmediate); // let it settle first
    assert.strictEqual(await pending, 'late');
  });

  it('is awaited the same way twice', async () => {
    const pending = maybePromise(undefined, op(null, 'twice'));
    assert.strictEqual(await pending, 'twice');
    assert.strictEqual(await pending, 'twice');
  });

  it('composes with Promise.all', async () => {
    const results = await Promise.all([
      maybePromise(undefined, op(null, 1)),
      maybePromise(undefined, op(null, 2))
    ]);
    assert.deepStrictEqual(results, [1, 2]);
  });

  it('supports .catch and .finally', async () => {
    let ranFinally = false;
    const message = await maybePromise(undefined, op(['nope']))
      .catch(err => err.message)
      .finally(() => {
        ranFinally = true;
      });
    assert.strictEqual(message, 'nope');
    assert.ok(ranFinally);
  });

  // The reason this is a thenable rather than a Promise. Calling without a
  // callback has always been fire-and-forget; a real Promise would turn a
  // silently-dropped failure into a process-terminating unhandled rejection.
  it('does not produce an unhandled rejection when the result is ignored', () => {
    const script = `
      const { maybePromise } = require(${JSON.stringify(require.resolve('../lib/promisify'))});
      process.on('unhandledRejection', e => {
        console.error('UNHANDLED');
        process.exit(3);
      });
      // fire and forget, exactly as examples/monitor1.js does
      maybePromise(undefined, cb => setImmediate(() => cb(['it failed'])));
      setTimeout(() => { console.log('survived'); process.exit(0); }, 300);
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8'
    });
    assert.match(out, /survived/);
  });

  it('still rejects normally when the result is observed', async () => {
    await assert.rejects(() => maybePromise(undefined, op(['observed'])), {
      message: 'observed'
    });
  });
});

describe('toDBusError', () => {
  it('passes an Error through untouched', () => {
    const err = new Error('already');
    assert.strictEqual(toDBusError(err), err);
  });

  it('falls back to the dbus name when the body is empty', () => {
    const body = Object.assign([], {
      dbusName: 'org.freedesktop.DBus.Error.Failed'
    });
    assert.strictEqual(
      toDBusError(body).message,
      'org.freedesktop.DBus.Error.Failed'
    );
  });

  it('never produces an empty message', () => {
    assert.ok(toDBusError([]).message.length > 0);
    assert.ok(toDBusError(undefined).message.length > 0);
  });
});
