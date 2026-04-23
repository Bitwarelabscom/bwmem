/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.cjs', '*.mjs', 'examples/', 'tests/'],
  rules: {
    // Allow underscore-prefixed unused args, which we use deliberately for
    // handler signatures (e.g., `_reply`).
    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    }],
    'no-unused-vars': 'off',

    // Enforce no implicit any on function parameters / return types where
    // inference isn't clear — but leave inferred locals alone (tsc handles).
    '@typescript-eslint/no-explicit-any': 'error',

    // The non-null-assertion rule is a warn rather than error: the codebase
    // uses `request.tenant!` in many places after an auth hook guarantees it
    // is set. Rewriting those is a larger refactor (see BwMem refactor).
    '@typescript-eslint/no-non-null-assertion': 'warn',

    // Allow `as` casts — the pg-driver row mapping pattern relies on them.
    // A follow-up pass introduces typed row interfaces to reduce this.
    '@typescript-eslint/no-explicit-any': 'error',
  },
};
