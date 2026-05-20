// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import orbitPlugin from './eslint-rules/index.js';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'eslint-rules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    plugins: {
      orbit: orbitPlugin,
    },
    rules: {
      // I7 — block new throw sites that interpolate PII identifiers
      // (phone, email, NIN, etc.) into client-facing error messages.
      // ARCH-6 runtime sanitiser is the backstop; this rule shifts
      // the catch left so NFR-S3 holds as the codebase grows.
      'orbit/no-pii-in-error': 'error',
    },
  },
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // ARCH-1: every Naira value must be constructed from a string. A
      // numeric literal silently loses kobo precision (e.g. naira(0.1+0.2)
      // becomes 0.30000000000000004) — force callers to write the exact
      // wire-form string, naira('1000.00').
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='naira'] > Literal[raw=/^-?[0-9]/]",
          message:
            "naira() must be called with a string (e.g. naira('1000.00')), not a numeric literal. Numeric literals lose kobo precision.",
        },
      ],
    },
  },
  {
    files: ['**/*.spec.ts'],
    rules: {
      // Tests may exercise the runtime `number` overload of naira(...) on
      // purpose (e.g., to verify the transformer normalizes numbers).
      'no-restricted-syntax': 'off',
    },
  },
);
