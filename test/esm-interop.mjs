// The package is CommonJS. This asserts that costs an ESM consumer nothing.
//
// BIG_FUTURE_PLANS 4.1 decided against ESM-only on the strength of these
// facts, so they need to keep being facts. The one that can rot silently is
// the named-import list: `import { sessionBus }` from a CJS module works
// because `cjs-module-lexer` statically finds the assignments in index.js, and
// a refactor that assigns exports some way it cannot follow would drop them
// from the ESM surface with nothing failing here or anywhere else.
//
// A .mjs file, so it is ESM regardless of what package.json says. Run by
// `npm run test:raw` along with everything else -- node:test picks up .mjs.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import dbus from '../index.js';
import * as namespace from '../index.js';
import {
  sessionBus,
  systemBus,
  createClient,
  createConnection,
  createBroker,
  defineInterface,
  Variant,
  variantValue,
  variantSignature,
  toPlain,
  messageType
} from '../index.js';
import { withClassicTypes, toClassicError } from '../lib/compat.js';
import marshall from '../lib/marshall.js';
import unmarshall from '../lib/unmarshall.js';

describe('ESM interop with the CommonJS package', () => {
  it('has a usable default import', () => {
    assert.strictEqual(typeof dbus.sessionBus, 'function');
    assert.strictEqual(typeof dbus.Variant, 'function');
  });

  it('exposes every runtime export as a named import', () => {
    // The assertion that matters: not "the ones I remembered to list", but
    // every key the CommonJS object actually has.
    const runtime = Object.keys(dbus).sort();
    const named = Object.keys(namespace).filter(k => k !== 'default');
    const missing = runtime.filter(k => !named.includes(k));
    assert.deepStrictEqual(
      missing,
      [],
      `not importable by name from ESM: ${missing.join(', ')}`
    );
    assert.ok(
      runtime.length > 15,
      `expected the full surface, got ${runtime.length}`
    );
  });

  it('binds the named imports to the same functions', () => {
    for (const [name, fn] of Object.entries({
      sessionBus,
      systemBus,
      createClient,
      createConnection,
      createBroker,
      defineInterface,
      Variant,
      variantValue,
      variantSignature,
      toPlain
    })) {
      assert.strictEqual(fn, dbus[name], name);
    }
    assert.deepStrictEqual(messageType, dbus.messageType);
  });

  it('resolves subpath exports', () => {
    assert.strictEqual(typeof withClassicTypes, 'function');
    assert.strictEqual(typeof toClassicError, 'function');
  });

  it('resolves deep lib/ subpaths', () => {
    assert.strictEqual(typeof marshall, 'function');
    assert.strictEqual(typeof unmarshall, 'function');
  });

  it('keeps instanceof working across the boundary', () => {
    // Two module systems, one class. This is the property a dual package
    // would destroy, and the reason never to publish one.
    assert.ok(new Variant('s', 'x') instanceof dbus.Variant);
  });

  it('round-trips a value through the imported functions', () => {
    const [dict] = unmarshall(marshall('a{sv}', [{ n: 7n }]), 'a{sv}');
    assert.deepStrictEqual(toPlain(dict), { n: 7n });
  });
});
