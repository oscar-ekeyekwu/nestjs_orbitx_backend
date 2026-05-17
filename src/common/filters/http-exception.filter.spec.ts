import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { AllExceptionsFilter } from './http-exception.filter';
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
});
