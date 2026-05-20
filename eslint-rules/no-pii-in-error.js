/**
 * I7 — custom ESLint rule: forbid PII identifiers inside error
 * messages thrown to clients.
 *
 * Rule fires when a `throw new <Anything>Exception(...)` argument
 * contains a string (template literal or string-concat) that
 * interpolates a PII-looking expression. The runtime sanitizer
 * (ARCH-6) is still the last line of defense, but catching new
 * throw sites at lint time keeps NFR-S3 from rotting as the
 * codebase grows.
 *
 * Heuristic: a `MemberExpression` whose final property name matches
 * one of the PII property keywords (`phone`, `email`, `password`,
 * `token`, `nin`, `bvn`, `name`, `address`, `firstName`,
 * `lastName`, `first_name`, `last_name`) embedded inside the
 * exception's message argument is flagged.
 *
 * Opt-out for legitimate cases:
 *   // eslint-disable-next-line orbit/no-pii-in-error -- reason
 *
 * Coverage: template literals + binary `+` string concatenation +
 * inline object messages (`{ message: \`...${x.email}...\` }`).
 */

'use strict';

const PII_PROPERTY_NAMES = new Set([
  'phone',
  'email',
  'password',
  'token',
  'nin',
  'bvn',
  'name',
  'address',
  'firstName',
  'lastName',
  'first_name',
  'last_name',
]);

const EXCEPTION_NAME_SUFFIX = 'Exception';

function isPiiMemberExpression(node) {
  if (!node || node.type !== 'MemberExpression') return false;
  const prop = node.property;
  if (!prop) return false;
  // Computed access (`user['phone']`) — read the raw value.
  if (node.computed && prop.type === 'Literal' && typeof prop.value === 'string') {
    return PII_PROPERTY_NAMES.has(prop.value);
  }
  // Static access (`user.phone`).
  if (!node.computed && prop.type === 'Identifier') {
    return PII_PROPERTY_NAMES.has(prop.name);
  }
  return false;
}

/**
 * Walk an expression looking for a PII member access. Handles:
 *   - TemplateLiteral expressions
 *   - BinaryExpression('+', left, right)
 *   - ObjectExpression's `message` property value
 *   - Direct MemberExpression
 */
function findPiiAccess(node) {
  if (!node) return null;
  if (isPiiMemberExpression(node)) return node;

  switch (node.type) {
    case 'TemplateLiteral': {
      for (const expr of node.expressions) {
        const hit = findPiiAccess(expr);
        if (hit) return hit;
      }
      return null;
    }
    case 'BinaryExpression': {
      if (node.operator !== '+') return null;
      return findPiiAccess(node.left) || findPiiAccess(node.right);
    }
    case 'ObjectExpression': {
      for (const prop of node.properties) {
        if (
          prop.type !== 'Property' ||
          !prop.key ||
          (prop.key.type === 'Identifier' && prop.key.name !== 'message') ||
          (prop.key.type === 'Literal' && prop.key.value !== 'message')
        ) {
          continue;
        }
        const hit = findPiiAccess(prop.value);
        if (hit) return hit;
      }
      return null;
    }
    case 'LogicalExpression':
    case 'ConditionalExpression': {
      // `a ?? b` / `a ? b : c` — scan every side.
      return (
        findPiiAccess(node.left) ||
        findPiiAccess(node.right) ||
        findPiiAccess(node.consequent) ||
        findPiiAccess(node.alternate) ||
        findPiiAccess(node.test) ||
        null
      );
    }
    default:
      return null;
  }
}

function isExceptionConstructor(node) {
  if (!node || node.type !== 'NewExpression') return false;
  const callee = node.callee;
  if (!callee) return false;
  if (callee.type === 'Identifier') {
    return callee.name.endsWith(EXCEPTION_NAME_SUFFIX);
  }
  // Handles namespaced refs (e.g. `Common.BadRequestException`) by
  // checking the rightmost identifier.
  if (callee.type === 'MemberExpression' && callee.property) {
    return (
      callee.property.type === 'Identifier' &&
      callee.property.name.endsWith(EXCEPTION_NAME_SUFFIX)
    );
  }
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid PII identifiers (phone, email, password, token, NIN, BVN, name, address) in client-facing error messages. ARCH-6 sanitizer is the runtime backstop; this rule catches new throw sites at lint time.',
    },
    schema: [],
    messages: {
      noPii:
        'Error message embeds PII (.{{name}}). Use a generic error and rely on ARCH-6 sanitisation for diagnostics. Opt out per-throw with `// eslint-disable-next-line orbit/no-pii-in-error -- reason: ...` if absolutely required.',
    },
  },

  create(context) {
    return {
      ThrowStatement(node) {
        const arg = node.argument;
        if (!isExceptionConstructor(arg)) return;
        if (!arg.arguments || arg.arguments.length === 0) return;
        for (const exceptionArg of arg.arguments) {
          const hit = findPiiAccess(exceptionArg);
          if (hit) {
            const piiName =
              hit.computed && hit.property.type === 'Literal'
                ? String(hit.property.value)
                : hit.property.type === 'Identifier'
                  ? hit.property.name
                  : '?';
            context.report({
              node: hit,
              messageId: 'noPii',
              data: { name: piiName },
            });
            return;
          }
        }
      },
    };
  },
};
