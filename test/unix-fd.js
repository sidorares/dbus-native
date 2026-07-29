// UNIX_FD ('h') is not supported, and the error says why.
//
// "Unknown data type format: h" was accurate but misleading: the signature
// parses, the type is real, and the reason it cannot be carried has nothing to
// do with this library failing to recognise it. A file descriptor is passed as
// ancillary data (SCM_RIGHTS) alongside the message rather than inside it, and
// Node has no API for that.
//
// See ROADMAP.md §2.8 for the options that were measured, and why none of them
// works today.

const { describe, it } = require('node:test');
const assert = require('assert');
const marshall = require('../lib/marshall');
const unmarshall = require('../lib/unmarshall');
const parseSignature = require('../lib/signature');

describe("UNIX_FD ('h')", () => {
  it('parses as a signature, since it is a real type', () => {
    assert.deepStrictEqual(parseSignature('h'), [{ type: 'h', child: [] }]);
  });

  it('cannot be written, and says why', () => {
    assert.throws(
      () => marshall('h', [0]),
      err => {
        assert.match(err.message, /UNIX_FD \('h'\) is not supported/);
        assert.match(err.message, /cannot be written/);
        assert.match(err.message, /ancillary data \(SCM_RIGHTS\)/);
        return true;
      }
    );
  });

  it('cannot be read, and says why', () => {
    assert.throws(
      () => unmarshall(Buffer.alloc(4), 'h'),
      err => {
        assert.match(err.message, /UNIX_FD \('h'\) is not supported/);
        assert.match(err.message, /cannot be read/);
        return true;
      }
    );
  });

  it('points at the reason rather than at this library', () => {
    // Someone hitting this should not have to work out whether it is our bug.
    const message = (() => {
      try {
        marshall('h', [0]);
      } catch (e) {
        return e.message;
      }
    })();
    assert.match(message, /nodejs\/node\/issues\/53391/);
    assert.match(message, /ROADMAP/);
    // and which real-world APIs it costs them
    assert.match(message, /systemd|portals|PipeWire/);
  });

  it('is reported the same way inside a container', () => {
    assert.throws(() => marshall('ah', [[0]]), /UNIX_FD/);
    assert.throws(() => marshall('(sh)', [['x', 0]]), /UNIX_FD/);
  });

  it('leaves other unsupported types with the generic message', () => {
    // A type code the signature parser rejects never reaches the marshaller,
    // so this is the fallback for anything that parses but has no marshaller.
    const constants = require('../lib/constants');
    assert.strictEqual(
      constants.unsupportedType('Z', 'written'),
      'Unknown data type format: Z'
    );
  });
});
