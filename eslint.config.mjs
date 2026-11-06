// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
import js from '@eslint/js'
import prettier from 'eslint-config-prettier/flat'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['dist/**', 'node_modules/**', '*.tgz'] },
  {
    files: ['**/*.{ts,js,mjs}'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Beyond the strict presets: correctness checks the presets leave out.
      eqeqeq: 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Numbers may go into template strings; objects, nullish values, booleans and `any` still may not. The strict
      // default would mean wrapping ~50 HTTP statuses, counts and lengths in String(), which is exactly what the template
      // already does: that suppresses the check without adding a decision. The sites where number formatting matters are
      // handled explicitly instead (dollarsFromCents for cents, points() for points, toFixed for computed ratios).
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // amazon-cognito-identity-js is in maintenance mode (Amplify v5) and marks its classes deprecated. It is kept
      // deliberately for SRP sign-in; every other deprecation still fails the lint.
      '@typescript-eslint/no-deprecated': [
        'error',
        {
          allow: [
            {
              from: 'package',
              package: 'amazon-cognito-identity-js',
              name: ['AuthenticationDetails', 'CognitoUser', 'CognitoUserPool', 'CognitoUserSession'],
            },
          ],
        },
      ],
    },
  },
  {
    // Only the ESLint config itself is plain JavaScript: lint it without type information.
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // node:test runs and awaits every test and suite it is handed; the Promise test() and describe() return is
    // only for callers that want to wait on one. Every other floating promise in the tests still fails the lint.
    // node:test's test(), describe(), it() and suite() return promises the runner awaits itself; any other unawaited promise
    // in a test still fails the lint.
    files: ['test/**'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', name: ['test', 'describe', 'it', 'suite'], package: 'node:test' }] },
      ],
    },
  },
  {
    // stdout carries the MCP protocol on stdio: anything else written there corrupts it. Use process.stderr.
    files: ['src/**'],
    rules: { 'no-console': 'error' },
  },
  prettier
)
