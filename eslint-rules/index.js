/**
 * I7 — `orbit/*` ESLint plugin namespace. Lives inside the backend
 * repo (not a published npm package) and is wired into
 * `eslint.config.mjs` via the `plugins: { orbit: ... }` slot.
 */

'use strict';

const noPiiInError = require('./no-pii-in-error');

module.exports = {
  rules: {
    'no-pii-in-error': noPiiInError,
  },
};
