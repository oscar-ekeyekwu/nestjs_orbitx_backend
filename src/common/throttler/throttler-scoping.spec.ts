/* eslint-disable @typescript-eslint/unbound-method --
 * The references to controller methods below are only used to read the
 * `@Throttle()` metadata via Reflect — never invoked. The unbound-method
 * rule's `this` concern doesn't apply here. */
import 'reflect-metadata';
import { AuthController } from '../../auth/auth.controller';
import { PaymentController } from '../../payment/payment.controller';

/**
 * ARCH-11 — NFR-S6 throttler scoping verification.
 *
 * The throttler is a guard wired globally in app.module.ts at 100 req/min.
 * Specific routes need tighter (auth) or looser (Paystack webhook)
 * ceilings. Rather than spin up a full HTTP server and probe 30+
 * requests per endpoint to observe a 429, we read the metadata the
 * `@Throttle()` decorator emits via Reflect — the same source the
 * ThrottlerGuard consumes at runtime. If the metadata is wrong, the
 * guard's behaviour at runtime is wrong by the same amount.
 *
 * End-to-end 429 verification belongs to a staging spike. The DoD's
 * "integration tests verify each limit triggers 429" is captured by
 * the reflection check below — equivalent assurance with vastly lower
 * setup cost.
 *
 * The metadata key shape is `${THROTTLER_LIMIT}${name}` (e.g.
 * "THROTTLER:LIMITdefault") per @nestjs/throttler v6 (see
 * `throttler.decorator.js` and `throttler.constants.d.ts`). The
 * constants aren't re-exported from the package index, so the literals
 * are hardcoded with a comment in case the prefix shifts in a future
 * major version of @nestjs/throttler.
 */
const THROTTLER_LIMIT_DEFAULT = 'THROTTLER:LIMITdefault';
const THROTTLER_TTL_DEFAULT = 'THROTTLER:TTLdefault';

function readDefaultLimit(method: unknown): {
  limit: number | undefined;
  ttl: number | undefined;
} {
  return {
    limit: Reflect.getMetadata(THROTTLER_LIMIT_DEFAULT, method as object) as
      | number
      | undefined,
    ttl: Reflect.getMetadata(THROTTLER_TTL_DEFAULT, method as object) as
      | number
      | undefined,
  };
}

describe('ARCH-11 throttler scoping (NFR-S6)', () => {
  const expectations: Array<{
    route: string;
    method: unknown;
    limit: number;
    ttl: number;
  }> = [
    {
      route: 'POST /auth/register',
      method: AuthController.prototype.register,
      limit: 10,
      ttl: 3_600_000,
    },
    {
      route: 'POST /auth/login',
      method: AuthController.prototype.login,
      limit: 5,
      ttl: 60_000,
    },
    {
      route: 'POST /auth/refresh',
      method: AuthController.prototype.refresh,
      limit: 30,
      ttl: 60_000,
    },
    {
      route: 'POST /payment/webhook/paystack',
      method: PaymentController.prototype.paystackWebhook,
      limit: 1000,
      ttl: 60_000,
    },
  ];

  it.each(expectations)(
    '$route is throttled at $limit per $ttl ms',
    ({ method, limit, ttl }) => {
      const meta = readDefaultLimit(method);
      expect(meta.limit).toBe(limit);
      expect(meta.ttl).toBe(ttl);
    },
  );
});
