/**
 * I7 — RuleTester for the no-pii-in-error rule.
 *
 * Run with `node eslint-rules/no-pii-in-error.test.js` — the test
 * uses ESLint's built-in RuleTester so there's no jest/mocha
 * dependency. CI invokes it via the script wired in package.json.
 */

'use strict';

const { RuleTester } = require('eslint');
const rule = require('./no-pii-in-error');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('no-pii-in-error', rule, {
  valid: [
    // Generic error message with no PII.
    `throw new BadRequestException('Invalid input.');`,
    // Object form with a safe message.
    `throw new BadRequestException({ message: 'Driver not found.' });`,
    // PII access OUTSIDE an exception constructor is fine (logging,
    // assignments, etc.).
    `const x = user.email;`,
    // Static fields named like PII but not on a member expression.
    `throw new BadRequestException('email format invalid');`,
    // Exception that touches only the error code.
    `throw new BadRequestException({ errorCode: 'AUTH_001', message: 'Unauthorized.' });`,
    // Non-PII member access (e.g. order id).
    `throw new BadRequestException(\`Order \${order.id} not found.\`);`,
  ],
  invalid: [
    {
      code: `throw new BadRequestException(\`User \${user.phone} not found.\`);`,
      errors: [{ messageId: 'noPii', data: { name: 'phone' } }],
    },
    {
      code: `throw new BadRequestException('User ' + user.email + ' is suspended.');`,
      errors: [{ messageId: 'noPii', data: { name: 'email' } }],
    },
    {
      code: `throw new BadRequestException({ message: \`Hello \${u.first_name}\` });`,
      errors: [{ messageId: 'noPii', data: { name: 'first_name' } }],
    },
    {
      code: `throw new ForbiddenException(\`NIN \${kyc.nin} blocked\`);`,
      errors: [{ messageId: 'noPii', data: { name: 'nin' } }],
    },
    {
      code: `throw new UnauthorizedException(\`Token \${session.token} expired\`);`,
      errors: [{ messageId: 'noPii', data: { name: 'token' } }],
    },
    // Computed access — `user['email']` — should also flag.
    {
      code: `throw new BadRequestException(\`Hi \${u['email']}\`);`,
      errors: [{ messageId: 'noPii', data: { name: 'email' } }],
    },
    // Namespaced exception name (e.g. `Common.BadRequestException`).
    {
      code: `throw new Common.BadRequestException(\`User \${user.phone}\`);`,
      errors: [{ messageId: 'noPii', data: { name: 'phone' } }],
    },
  ],
});

// eslint-disable-next-line no-console
console.log('no-pii-in-error rule tests passed.');
