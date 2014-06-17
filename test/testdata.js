module.exports = {
    // signature, data, not expected to fail?, data after unmarshall (when expected to convert to canonic form and different from input)
    'simple types': [
        ['s', ['short string']],
        ['s', ['str30000chars']],
        ['o', ['/object/path']],
        ['o', ['invalid/object/path'], false],
        ['g', ['xxxtt[t]s{u}uuiibb']],
        ['g', ['signature'], false], // TODO: validate on input
        //['g', [str300chars], false],  // max 255 chars
        ['o', ['/']],
        ['bbbbbb', [0, 1, false, true, -20, 20], true, [ false, true, false, true, true, true ]],
        ['y', [10]],
        //['y', [300], false],  // TODO: validate on input
        //['y', [-10]],  // TODO: validate on input
        ['n', [300]],
        ['n', [16300]],
        //['n', [65535], false] // TODO: signed 16 bit
        //['n', [-100], false];  // TODO: validate on input, should fail
        ['q', [65535]],
        //['q', [-100], false],   // TODO: validate on input, should fail
        // i - signed, u - unsigned
        ['i', [1048576]],
        ['i', [0]],
        ['i', [-1]],
        ['u', [1048576]],
        ['u', [0]],
        //['u', [-1], false]  // TODO validate input, should fail
        ['dsai', [3.141590118408203, 'test string', [1, 2, 3, 0, 0, 0, 4, 5, 6, 7]] ]
    ],
    'simple structs': [
        ['(yyy)y', [[1, 2, 3], 4]],
        ['y(yyy)y', [5, [1, 2, 3], 4]],
        ['yy(yyy)y', [5, 6, [1, 2, 3], 4]],
        ['yyy(yyy)y', [5, 6, 7, [1, 2, 3], 4]],
        ['yyyy(yyy)y', [5, 6, 7, 8, [1, 2, 3], 4]],
        ['yyyyy(yyy)y', [5, 6, 7, 8, 9, [1, 2, 3], 4]]
    ],
    'arrays of simple types': [
        ['ai', [[1, 2, 3, 4, 5, 6, 7]]],
        ['aai', [[[300, 400, 500], [1, 2, 3, 4, 5, 6, 7]]] ],
        ['aiai', [[1, 2, 3], [300, 400, 500]] ],
    ],
    'compound types': [
        ['iyai', [10, 100, [1, 2, 3, 4, 5, 6]]],
        // TODO: fix 'array of structs offset problem
        ['a(iyai)', [[[10, 100, [1, 2, 3, 4, 5, 6]], [11, 200, [15, 4, 5, 6]]]] ],
        ['sa(iyai)', ['test test test test', [[10, 100, [1, 2, 3, 4, 5, 6]], [11, 200, [15, 4, 5, 6]]]]],
        ['a(iyai)', [[[10, 100, [1, 2, 3, 4, 5, 6]], [11, 200, [15, 4, 5, 6]]]]],
        ['a(yai)', [[[100, [1, 2, 3, 4, 5, 6]], [200, [15, 4, 5, 6]]]]],
        ['a(yyai)', [[[100, 101, [1, 2, 3, 4, 5, 6]], [200, 201, [15, 4, 5, 6]]]]],
        ['a(yyyai)', [[[100, 101, 102, [1, 2, 3, 4, 5, 6]], [200, 201, 202, [15, 4, 5, 6]]]]],
        ['ai', [[1, 2, 3, 4, 5, 6]]],
        ['aii', [[1, 2, 3, 4, 5, 6], 10]],
        ['a(ai)', [[  [[1, 2, 3, 4, 5, 6]], [[15, 4, 5, 6]] ]]],
        ['aai', [[[1, 2, 3, 4, 5, 6], [15, 4, 5, 6]]]],
    ],
    'variants': [
        ['av', [[  ['i', 5], ['s', 'test'], ['y', 6], ['s', '7'], ['i', 999]  ]], true, [[ 5, 'test', 6, '7', 999 ]]],
        ['v', [ ['v', ['i', 7777]] ], true, [ 7777 ]]
    ],
    'objects': [
        ['a{si}', [[ ['key1', 1],['key2', 2],['key3', 3] ]], true, [ { key1: 1, key2: 2, key3: 3 } ]],
        ['a{sa{sa(ss)}}i',
            [ [
                ['a', [
                    ['b', [
                        [ 'c', 'value' ]]
                    ]
                ] ]
            ], 5],
            true,
            [ {
                a: {
                    b: [
                        ['c', 'value' ]]
                }
            }, 5 ]]
    ]
};
