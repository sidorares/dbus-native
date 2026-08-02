const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier/flat');

module.exports = [
  {
    // `website/` is a separate npm project with a separate toolchain -- JSX and
    // ESM, neither of which this config is set up to parse. It lints nothing of
    // its own either; there are ten files in it and none ship.
    ignores: ['node_modules/**', 'coverage/**', 'website/**']
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
        // `Symbol.asyncDispose` predates our floor, but these two stacks only
        // arrive in Node 24 -- so code using them has to feature-detect. The
        // `using` *keyword* also needs 24 and must not appear in source or
        // tests: it is a syntax error on 22, which fails the file before any
        // skip can run.
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
  },
  {
    // The package is CommonJS, so `sourceType: 'commonjs'` above is right for
    // everything except the one file that deliberately is not: the ESM interop
    // check, which has to be real ESM to be worth anything.
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module' }
  }
];
// No test-globals block: node:test has no globals, so describe/it/before are
// imported like anything else and a missing import is a lint error rather
// than a runtime one.
