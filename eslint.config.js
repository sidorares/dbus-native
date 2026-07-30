const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier/flat');

module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**']
  },
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        // Explicit resource management. Measured, not assumed:
        // `Symbol.asyncDispose` exists from Node 20, but these two stacks only
        // from Node 24 -- so code using them has to feature-detect on our floor
        // of 20.8. The `using` *keyword* also needs 24 and must not appear in
        // source or tests: it is a syntax error on the older two, which fails
        // the file before any skip can run.
        DisposableStack: 'readonly',
        AsyncDisposableStack: 'readonly'
      }
    },
    rules: {
      'no-constant-condition': ['error', { checkLoops: false }],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
      'no-empty': 'off',
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'prefer-arrow-callback': ['error', { allowNamedFunctions: true }],
      'prefer-template': 'error',
      'object-shorthand': ['error', 'properties'],
      'no-useless-concat': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
];
// No test-globals block: node:test has no globals, so describe/it/before are
// imported like anything else and a missing import is a lint error rather
// than a runtime one.
