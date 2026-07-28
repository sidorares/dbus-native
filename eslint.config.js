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
        ...globals.node
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
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.mocha,
        xit: 'readonly'
      }
    }
  }
];
