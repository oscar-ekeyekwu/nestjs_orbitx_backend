import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { AllExceptionsFilter, sanitize } from './http-exception.filter';
import { ErrorCodes } from '../constants/error-codes';

interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
  jsonPayload?: unknown;
  statusValue?: number;
}

function buildHost(req: { url: string; method: string }): {
  host: ArgumentsHost;
  response: MockResponse;
} {
  const response: MockResponse = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockImplementation((value: number) => {
    response.statusValue = value;
    return response;
  });
  response.json.mockImplementation((value: unknown) => {
    response.jsonPayload = value;
    return response;
  });

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => req,
    }),
  } as unknown as ArgumentsHost;

  return { host, response };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  describe('audit-immutability mapping (ARCH-7)', () => {
    it('returns SYS_005 + 403 when Postgres denies UPDATE on approval_decisions', () => {
      // Shape mirrors TypeORM's QueryFailedError wrapping a pg-driver error
      // with sqlState 42501 (insufficient_privilege).
      const exception = Object.assign(
        new Error('permission denied for table approval_decisions'),
        {
          name: 'QueryFailedError',
          driverError: {
            code: '42501',
            table: 'approval_decisions',
            message: 'permission denied for table approval_decisions',
          },
        },
      );

      const { host, response } = buildHost({
        url: '/api/v1/admin/approvals/abc',
        method: 'PATCH',
      });
      filter.catch(exception, host);

      const body = response.jsonPayload as Record<string, unknown>;
      expect(response.statusValue).toBe(HttpStatus.FORBIDDEN);
      expect(body.errorCode).toBe(ErrorCodes.SYS_005);
      expect(body.success).toBe(false);
      expect(body.message).toMatch(/append-only/i);
    });

    it('returns SYS_005 when Postgres denies UPDATE on transactions', () => {
      const exception = Object.assign(
        new Error('permission denied for table transactions'),
        {
          driverError: {
            code: '42501',
            table: 'transactions',
            message: 'permission denied for table transactions',
          },
        },
      );

      const { host, response } = buildHost({
        url: '/api/v1/wallet/transactions/123',
        method: 'DELETE',
      });
      filter.catch(exception, host);

      const body = response.jsonPayload as Record<string, unknown>;
      expect(body.errorCode).toBe(ErrorCodes.SYS_005);
      expect(response.statusValue).toBe(HttpStatus.FORBIDDEN);
    });

    it('does NOT promote a 42501 against a non-audit table to SYS_005', () => {
      const exception = Object.assign(
        new Error('permission denied for table orders'),
        {
          driverError: {
            code: '42501',
            table: 'orders',
            message: 'permission denied for table orders',
          },
        },
      );

      const { host, response } = buildHost({
        url: '/api/v1/orders/abc',
        method: 'PATCH',
      });
      filter.catch(exception, host);

      const body = response.jsonPayload as Record<string, unknown>;
      expect(body.errorCode).not.toBe(ErrorCodes.SYS_005);
    });
  });

  describe('existing behaviour preserved', () => {
    it('returns AUTH_002 for an HttpException with 401 status', () => {
      const { host, response } = buildHost({
        url: '/api/v1/users/me',
        method: 'GET',
      });
      filter.catch(
        new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED),
        host,
      );

      const body = response.jsonPayload as Record<string, unknown>;
      expect(body.errorCode).toBe(ErrorCodes.AUTH_002);
      expect(response.statusValue).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('falls back to SYS_001 for an unknown plain Error', () => {
      const { host, response } = buildHost({
        url: '/api/v1/health',
        method: 'GET',
      });
      filter.catch(new Error('boom'), host);

      const body = response.jsonPayload as Record<string, unknown>;
      expect(body.errorCode).toBe(ErrorCodes.SYS_001);
      expect(response.statusValue).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(body.message).toBe('boom');
    });
  });

  describe('PII sanitizer (ARCH-6, NFR-S3)', () => {
    describe('sanitize() — pattern coverage', () => {
      it('redacts email addresses', () => {
        expect(sanitize('User oscar@gemspaysolution.com not found')).toBe(
          'User [REDACTED] not found',
        );
      });

      it('redacts Nigerian +234 phone numbers', () => {
        expect(sanitize('OTP sent to +2348012345678')).toBe(
          'OTP sent to [REDACTED]',
        );
      });

      it('redacts Nigerian 0-prefix phone numbers / 11-digit NINs', () => {
        expect(sanitize('OTP sent to 08012345678')).toBe(
          'OTP sent to [REDACTED]',
        );
        expect(sanitize('NIN 12345678901 is invalid')).toBe(
          'NIN [REDACTED] is invalid',
        );
      });

      it('redacts Paystack txn ids', () => {
        expect(sanitize('Failed to refund txn_abc123XYZ')).toBe(
          'Failed to refund [REDACTED]',
        );
      });

      it('redacts multiple PII tokens in one message', () => {
        const dirty =
          'Customer oscar@example.com (phone +2348012345678) tried txn_abcd';
        expect(sanitize(dirty)).toBe(
          'Customer [REDACTED] (phone [REDACTED]) tried [REDACTED]',
        );
      });

      it('leaves non-PII strings untouched', () => {
        expect(sanitize('Order ORD-2026-05-17-001 delivered')).toBe(
          'Order ORD-2026-05-17-001 delivered',
        );
      });
    });

    describe('filter wiring', () => {
      it('redacts message in the response envelope but keeps the original in console.error', () => {
        const { host, response } = buildHost({
          url: '/api/v1/users',
          method: 'POST',
        });
        const original =
          'Email oscar@example.com already exists for +2348012345678';

        filter.catch(new HttpException(original, HttpStatus.CONFLICT), host);

        const body = response.jsonPayload as Record<string, unknown>;
        expect(body.message).toBe(
          'Email [REDACTED] already exists for [REDACTED]',
        );

        // The server-side log should still receive the unredacted text
        // so on-call can correlate with actual rows.
        const calls = consoleError.mock.calls as unknown as unknown[][];
        const loggedPayload = calls[0][1] as { message: string };
        expect(loggedPayload.message).toBe(original);
      });

      it('redacts string entries inside errors[] from a validation 400', () => {
        const { host, response } = buildHost({
          url: '/api/v1/users',
          method: 'POST',
        });

        filter.catch(
          new HttpException(
            {
              message: 'Validation failed',
              errors: [
                'email oscar@example.com must be unique',
                { field: 'phone', value: '+2348012345678', code: 'duplicate' },
              ],
            },
            HttpStatus.BAD_REQUEST,
          ),
          host,
        );

        const body = response.jsonPayload as {
          errors: unknown[];
        };
        // String entry: sanitized in place.
        expect(body.errors[0]).toBe('email [REDACTED] must be unique');
        // Object entry: pass-through (deep object scrubbing is a future
        // story; flagging here keeps the test honest).
        expect(body.errors[1]).toEqual({
          field: 'phone',
          value: '+2348012345678',
          code: 'duplicate',
        });
      });
    });
  });
});
