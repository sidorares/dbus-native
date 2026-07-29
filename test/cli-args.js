// `type:value` arguments, as dbus-send spells them.

const { describe, it } = require('node:test');
const assert = require('assert');
const { parseArgument, parseArguments } = require('../lib/cli/dbus-args');

describe('cli arguments: scalars', () => {
  const cases = [
    ['string:hello', 's', 'hello'],
    ['string:', 's', ''],
    ['string:with:colons', 's', 'with:colons'],
    ['string:with spaces', 's', 'with spaces'],
    ['objpath:/com/example/Obj', 'o', '/com/example/Obj'],
    ['signature:a{sv}', 'g', 'a{sv}'],
    ['boolean:true', 'b', true],
    ['boolean:false', 'b', false],
    ['boolean:1', 'b', true],
    ['boolean:0', 'b', false],
    ['byte:0', 'y', 0],
    ['byte:255', 'y', 255],
    ['int16:-32768', 'n', -32768],
    ['uint16:65535', 'q', 65535],
    ['int32:-7', 'i', -7],
    ['int32:+7', 'i', 7],
    ['uint32:4294967295', 'u', 4294967295],
    ['double:1.5', 'd', 1.5],
    ['double:-0.25', 'd', -0.25],
    ['double:3', 'd', 3]
  ];
  for (const [text, signature, value] of cases) {
    it(`parses ${text}`, () => {
      assert.deepStrictEqual(parseArgument(text), { signature, value });
    });
  }

  it('keeps 64-bit values exact, as BigInt', () => {
    // A Number could not carry these, and the whole point of the type is that
    // it can.
    assert.deepStrictEqual(parseArgument('int64:9223372036854775807'), {
      signature: 'x',
      value: 9223372036854775807n
    });
    assert.deepStrictEqual(parseArgument('int64:-9223372036854775808'), {
      signature: 'x',
      value: -9223372036854775808n
    });
    assert.deepStrictEqual(parseArgument('uint64:18446744073709551615'), {
      signature: 't',
      value: 18446744073709551615n
    });
  });

  it('leaves the smaller integers as numbers', () => {
    assert.strictEqual(typeof parseArgument('int32:7').value, 'number');
    assert.strictEqual(typeof parseArgument('int64:7').value, 'bigint');
  });
});

describe('cli arguments: containers', () => {
  it('parses an array', () => {
    assert.deepStrictEqual(parseArgument('array:string:a,b,c'), {
      signature: 'as',
      value: ['a', 'b', 'c']
    });
  });

  it('parses an empty array', () => {
    assert.deepStrictEqual(parseArgument('array:string:'), {
      signature: 'as',
      value: []
    });
  });

  it('parses an array of numbers, checking each element', () => {
    assert.deepStrictEqual(parseArgument('array:uint32:1,2,3'), {
      signature: 'au',
      value: [1, 2, 3]
    });
    assert.throws(
      () => parseArgument('array:byte:1,300'),
      /300 is out of range for y in array:byte/
    );
  });

  it('parses a dict', () => {
    assert.deepStrictEqual(
      parseArgument('dict:string:uint32:width,800,height,600'),
      {
        signature: 'a{su}',
        value: [
          ['width', 800],
          ['height', 600]
        ]
      }
    );
  });

  it('refuses a dict with an odd number of elements', () => {
    assert.throws(
      () => parseArgument('dict:string:string:a,b,c'),
      /needs an even number of elements, got 3/
    );
  });

  it('parses a dict of variants, where each value carries its own type', () => {
    // a{sv} is the most common dict on the bus, so it has to be expressible.
    assert.deepStrictEqual(
      parseArgument('dict:string:variant:urgency,byte:2,resident,boolean:true'),
      {
        signature: 'a{sv}',
        value: [
          ['urgency', ['y', 2]],
          ['resident', ['b', true]]
        ]
      }
    );
  });

  it('parses an empty dict of variants', () => {
    assert.deepStrictEqual(parseArgument('dict:string:variant:'), {
      signature: 'a{sv}',
      value: []
    });
  });

  it('parses an array of variants', () => {
    assert.deepStrictEqual(parseArgument('array:variant:int32:1,string:two'), {
      signature: 'av',
      value: [
        ['i', 1],
        ['s', 'two']
      ]
    });
  });

  it('checks the type inside a variant element', () => {
    assert.throws(
      () => parseArgument('dict:string:variant:k,byte:999'),
      /999 is out of range for y in dict:string:variant/
    );
    assert.throws(
      () => parseArgument('dict:string:variant:k,nonsense:1'),
      /Unknown type "nonsense"/
    );
  });

  it('parses a variant as [signature, value]', () => {
    assert.deepStrictEqual(parseArgument('variant:int32:42'), {
      signature: 'v',
      value: ['i', 42]
    });
    assert.deepStrictEqual(parseArgument('variant:string:hi'), {
      signature: 'v',
      value: ['s', 'hi']
    });
  });
});

describe('cli arguments: what it refuses', () => {
  const bad = [
    ['int32:notanumber', /i must be an integer, got "notanumber"/],
    ['int32:1.5', /must be an integer/],
    ['byte:256', /256 is out of range for y \(0\.\.255\)/],
    ['byte:-1', /out of range for y/],
    ['int16:32768', /out of range for n/],
    ['uint32:-1', /out of range for u/],
    ['uint64:18446744073709551616', /out of range for t/],
    ['int64:9223372036854775808', /out of range for x/],
    ['boolean:yes', /boolean must be true or false, got "yes"/],
    ['double:abc', /double must be a finite number/],
    ['double:Infinity', /must be a finite number/],
    ['nonsense:1', /Unknown type "nonsense"/],
    ['array:nonsense:a', /Unknown type "nonsense"/],
    ['string', /Missing value after "s"/],
    ['array:string', /Missing elements in array:string/]
  ];
  for (const [text, message] of bad) {
    it(`refuses ${text}`, () =>
      assert.throws(() => parseArgument(text), { message }));
  }

  it('names the known types when given an unknown one', () => {
    assert.throws(() => parseArgument('float:1'), /string, objpath, signature/);
  });

  it('refuses a non-string argument', () => {
    assert.throws(() => parseArgument(42), /must be a string/);
  });
});

describe('cli arguments: whole lists', () => {
  it('joins the signatures and collects the values', () => {
    assert.deepStrictEqual(
      parseArguments(['string:hello', 'int32:7', 'boolean:true']),
      { signature: 'sib', body: ['hello', 7, true] }
    );
  });

  it('handles an empty list, for a method that takes nothing', () => {
    assert.deepStrictEqual(parseArguments([]), { signature: '', body: [] });
    assert.deepStrictEqual(parseArguments(undefined), {
      signature: '',
      body: []
    });
  });

  it('builds the Notify call everyone reaches for first', () => {
    // org.freedesktop.Notifications.Notify(susssasa{sv}i)
    const { signature, body } = parseArguments([
      'string:my-app',
      'uint32:0',
      'string:',
      'string:summary',
      'string:body',
      'array:string:',
      'dict:string:string:',
      'int32:5000'
    ]);
    assert.strictEqual(signature, 'susssasa{ss}i');
    assert.deepStrictEqual(body, [
      'my-app',
      0,
      '',
      'summary',
      'body',
      [],
      [],
      5000
    ]);
  });

  it('round-trips through the marshaller', () => {
    // The real test of the shapes: the marshaller has to accept them.
    const marshall = require('../lib/marshall');
    const { signature, body } = parseArguments([
      'string:hello',
      'int64:9223372036854775807',
      'array:uint32:1,2,3',
      'dict:string:string:a,b',
      'variant:int32:42',
      'objpath:/com/example/Obj',
      'double:1.5',
      'boolean:true'
    ]);
    assert.doesNotThrow(() => marshall(signature, body));
    const buffer = marshall(signature, body);
    const DBusBuffer = require('../lib/dbus-buffer');
    const back = new DBusBuffer(buffer, 0, { returnBigInt: true }).read(
      signature
    );
    assert.strictEqual(back[0], 'hello');
    assert.strictEqual(back[1], 9223372036854775807n);
    assert.deepStrictEqual(back[2], [1, 2, 3]);
    assert.strictEqual(back[5], '/com/example/Obj');
    assert.strictEqual(back[6], 1.5);
    assert.strictEqual(back[7], true);
  });
});
