assert = require('assert');
const variant = require('../lib/variant');

// Test methodology:
// 1. Send a dbus command with the variant in the designated form such as this:
// gdbus call --session --dest org.test --object-path /org/test --method org.freedesktop.DBus.Properties.Set org.test.interface TestProp "<{'bat': <'baz'>}>"
// 2. Inspect the kind of object the marshaller turns it into
// 3. Parse the variant with variant.parse()
// 4. Make sure you get the desired JS object back

// <{'foo': 'bar', 'bat': 'baz'}>
var simpleDict = [
  [
    {
      type: 'a',
      child: [
        {
          type: '{',
          child: [{ type: 's', child: [] }, { type: 's', child: [] }]
        }
      ]
    }
  ],
  [[['foo', 'bar'], ['bat', 'baz']]]
];
assert.deepEqual(variant.parse(simpleDict), { foo: 'bar', bat: 'baz' });

// <{'foo': <'bar'>, 'bat': <53>}>
var dictOfStringVariant = [
  [
    {
      type: 'a',
      child: [
        {
          type: '{',
          child: [{ type: 's', child: [] }, { type: 'v', child: [] }]
        }
      ]
    }
  ],
  [
    [
      ['foo', [[{ type: 's', child: [] }], ['bar']]],
      ['bat', [[{ type: 'i', child: [] }], [53]]]
    ]
  ]
];
assert.deepEqual(variant.parse(dictOfStringVariant), { foo: 'bar', bat: 53 });

// <{'foo': [<'bar'>, <53>], 'bat': [<'baz'>, <21>]}>
var dictOfVariantLists = [
  [
    {
      type: 'a',
      child: [
        {
          type: '{',
          child: [
            { type: 's', child: [] },
            { type: 'a', child: [{ type: 'v', child: [] }] }
          ]
        }
      ]
    }
  ],
  [
    [
      [
        'foo',
        [
          [[{ type: 's', child: [] }], ['bar']],
          [[{ type: 'i', child: [] }], [53]]
        ]
      ],
      [
        'bat',
        [
          [[{ type: 's', child: [] }], ['baz']],
          [[{ type: 'i', child: [] }], [21]]
        ]
      ]
    ]
  ]
];

assert.deepEqual(variant.parse(dictOfVariantLists), {
  foo: ['bar', 53],
  bat: ['baz', 21]
});

// <[<{'foo':'bar'}>, <{'bat':'baz'}>, <53>]>
var listOfVariantDicts = [
  [{ type: 'a', child: [{ type: 'v', child: [] }] }],
  [
    [
      [
        [
          {
            type: 'a',
            child: [
              {
                type: '{',
                child: [{ type: 's', child: [] }, { type: 's', child: [] }]
              }
            ]
          }
        ],
        [[['foo', 'bar']]]
      ],
      [
        [
          {
            type: 'a',
            child: [
              {
                type: '{',
                child: [{ type: 's', child: [] }, { type: 's', child: [] }]
              }
            ]
          }
        ],
        [[['bat', 'baz']]]
      ],
      [[{ type: 'i', child: [] }], [53]]
    ]
  ]
];
assert.deepEqual(variant.parse(listOfVariantDicts), [
  { foo: 'bar' },
  { bat: 'baz' },
  53
]);

// <'foo'>
var simpleString = [[{ type: 's', child: [] }], ['foo']];
assert.equal(variant.parse(simpleString), 'foo');

// <['foo', 'bar']>
var listOfStrings = [
  [{ type: 'a', child: [{ type: 's', child: [] }] }],
  [['foo', 'bar']]
];
assert.deepEqual(variant.parse(listOfStrings), ['foo', 'bar']);

// <('foo', 'bar')>
var simpleStruct = [
  [{ type: '(', child: [{ type: 's', child: [] }, { type: 's', child: [] }] }],
  [['foo', 'bar']]
];
assert.deepEqual(variant.parse(simpleStruct), ['foo', 'bar']);

// <(<'foo'>, 53)>
var structWithVariant = [
  [{ type: '(', child: [{ type: 'v', child: [] }, { type: 'i', child: [] }] }],
  [[[[{ type: 's', child: [] }], ['foo']], 53]]
];
assert.deepEqual(variant.parse(structWithVariant), ['foo', 53]);

// <[('foo', 'bar'), ('bat', 'baz')]>
var listOfStructs = [
  [
    {
      type: 'a',
      child: [
        {
          type: '(',
          child: [{ type: 's', child: [] }, { type: 's', child: [] }]
        }
      ]
    }
  ],
  [[['foo', 'bar'], ['bat', 'baz']]]
];
assert.deepEqual(variant.parse(listOfStructs), [
  ['foo', 'bar'],
  ['bat', 'baz']
]);

// <('foo', 'bar', ('bat', 'baz'))>
var nestedStruct = [
  [
    {
      type: '(',
      child: [
        { type: 's', child: [] },
        { type: 's', child: [] },
        {
          type: '(',
          child: [
            { type: 's', child: [] },
            {
              type: '(',
              child: [{ type: 's', child: [] }, { type: 's', child: [] }]
            }
          ]
        }
      ]
    }
  ],
  [['foo', 'bar', ['bat', ['baz', 'bar']]]]
];
assert.deepEqual(variant.parse(nestedStruct), [
  'foo',
  'bar',
  ['bat', ['baz', 'bar']]
]);

// <('foo', 'bar', ('bat', ('baz', <'bar'>)))>
var nestedStructWithVariant = [
  [
    {
      type: '(',
      child: [
        { type: 's', child: [] },
        { type: 's', child: [] },
        {
          type: '(',
          child: [
            { type: 's', child: [] },
            {
              type: '(',
              child: [{ type: 's', child: [] }, { type: 'v', child: [] }]
            }
          ]
        }
      ]
    }
  ],
  [['foo', 'bar', ['bat', ['baz', [[{ type: 's', child: [] }], ['bar']]]]]]
];
assert.deepEqual(variant.parse(nestedStructWithVariant), [
  'foo',
  'bar',
  ['bat', ['baz', 'bar']]
]);

// <[<'foo'>, <('bar', ('bat', <[<'baz'>, <53>]>))>]>
var arrayWithinStruct = [
  [{ type: 'a', child: [{ type: 'v', child: [] }] }],
  [
    [
      [[{ type: 's', child: [] }], ['foo']],
      [
        [
          {
            type: '(',
            child: [
              { type: 's', child: [] },
              {
                type: '(',
                child: [{ type: 's', child: [] }, { type: 'v', child: [] }]
              }
            ]
          }
        ],
        [
          [
            'bar',
            [
              'bat',
              [
                [{ type: 'a', child: [{ type: 'v', child: [] }] }],
                [
                  [
                    [[{ type: 's', child: [] }], ['baz']],
                    [[{ type: 'i', child: [] }], [53]]
                  ]
                ]
              ]
            ]
          ]
        ]
      ]
    ]
  ]
];
assert.deepEqual(variant.parse(arrayWithinStruct), [
  'foo',
  ['bar', ['bat', ['baz', 53]]]
]);
