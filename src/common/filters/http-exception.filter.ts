import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  getErrorCodeByMessage,
  ErrorCodes,
  ErrorCode,
} from '../constants/error-codes';

interface NestExceptionPayload {
  message?: string | string[];
  errors?: unknown[];
}

interface ErrorResponseBody {
  success: false;
  errorCode: ErrorCode;
  message: string;
  statusCode: number;
  path: string;
  timestamp: string;
  errors?: unknown[];
}

// NFR-S5 / ARCH-7: tables whose UPDATE+DELETE privileges are revoked from
// the orbit_app role at the database layer. Any 42501 (insufficient
// privilege) Postgres error that mentions one of these tables is mapped
// to SYS_005 so the API surface is unambiguous about what happened.
const AUDIT_TABLES = ['approval_decisions', 'transactions'] as const;
const PG_INSUFFICIENT_PRIVILEGE = '42501';

interface PgDriverError {
  code?: string;
  table?: string;
  message?: string;
}

// NFR-S3 / ARCH-6: PII patterns scrubbed from any message that leaves
// the server in the response envelope. The console.error log inside
// `catch()` still sees the original, so on-call diagnostics aren't
// degraded. Patterns are intentionally permissive (false-positive bias)
// rather than precise — the cost of redacting a harmless string is
// always lower than leaking a real one.
//
// Add new patterns here ↓ and lower-case label-then-regex for clarity.
const PII_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  // Email
  {
    label: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  // Nigerian phone in +234 form (e.g. +2348012345678).
  { label: 'phone-intl', pattern: /\+234\d{10}/g },
  // Nigerian phone in 0-prefix form (e.g. 08012345678) AND 11-digit
  // NIN-shaped strings collide; both are scrubbed with one rule.
  // The \b anchors avoid eating digits out of a longer numeric token.
  { label: 'phone-local-or-nin', pattern: /\b\d{11}\b/g },
  // Paystack transaction id surface (also covers `txn_…` references
  // we mint internally).
  { label: 'paystack-txn', pattern: /\btxn_[A-Za-z0-9]+/g },
];

const PII_REDACTION = '[REDACTED]';

export function sanitize(msg: string): string {
  let result = msg;
  for (const { pattern } of PII_PATTERNS) {
    result = result.replace(pattern, PII_REDACTION);
  }
  return result;
}

function sanitizeErrors(errors: unknown[] | undefined): unknown[] | undefined {
  if (!errors) return undefined;
  return errors.map((entry) =>
    typeof entry === 'string' ? sanitize(entry) : entry,
  );
}

function isAuditImmutabilityViolation(exception: unknown): boolean {
  if (!exception || typeof exception !== 'object') return false;

  const err = exception as {
    driverError?: PgDriverError;
    code?: string;
    message?: string;
    table?: string;
  };
  const code = err.driverError?.code ?? err.code;
  if (code !== PG_INSUFFICIENT_PRIVILEGE) return false;

  const table = err.driverError?.table ?? err.table ?? '';
  const driverMessage = err.driverError?.message ?? '';
  const haystack =
    `${table} ${driverMessage} ${err.message ?? ''}`.toLowerCase();
  return AUDIT_TABLES.some((t) => haystack.includes(t));
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errorCode: ErrorCode = ErrorCodes.SYS_001;
    let errors: unknown[] | undefined;

    if (isAuditImmutabilityViolation(exception)) {
      status = HttpStatus.FORBIDDEN;
      errorCode = ErrorCodes.SYS_005;
      message =
        'Audit table is append-only at the database layer. UPDATE / DELETE on transactions and approval_decisions is denied to the application role.';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const payload = res as NestExceptionPayload;
        const payloadMessage = payload.message;
        message = Array.isArray(payloadMessage)
          ? payloadMessage.join('; ')
          : (payloadMessage ?? message);
        errors = payload.errors;
      }

      // Get error code based on message
      const detectedErrorCode = getErrorCodeByMessage(message);
      if (detectedErrorCode) {
        errorCode = detectedErrorCode;
      } else {
        // Map HTTP status to error codes
        switch (status) {
          case HttpStatus.UNAUTHORIZED:
            errorCode = ErrorCodes.AUTH_002;
            break;
          case HttpStatus.FORBIDDEN:
            errorCode = ErrorCodes.USER_004;
            break;
          case HttpStatus.NOT_FOUND:
            errorCode = ErrorCodes.USER_001;
            break;
          case HttpStatus.BAD_REQUEST:
            errorCode = ErrorCodes.VAL_001;
            break;
          case HttpStatus.TOO_MANY_REQUESTS:
            errorCode = ErrorCodes.SYS_004;
            break;
          default:
            errorCode = ErrorCodes.SYS_001;
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    // Server-side log keeps the **original** message so on-call can see
    // what actually happened. Sanitization runs only on the outbound
    // envelope below (NFR-S3).
    console.error('Exception caught:', {
      message,
      errorCode,
      status,
      path: request.url,
      method: request.method,
      stack: exception instanceof Error ? exception.stack : undefined,
    });

    const errorResponse: ErrorResponseBody = {
      success: false,
      errorCode,
      message: sanitize(message),
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    const sanitizedErrors = sanitizeErrors(errors);
    if (sanitizedErrors) {
      errorResponse.errors = sanitizedErrors;
    }

    response.status(status).json(errorResponse);
  }
}
