import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { getErrorCodeByMessage, ErrorCodes, ErrorCode } from '../constants/error-codes';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errorCode: ErrorCode = ErrorCodes.SYS_001;
    let errors: any[] | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object') {
        message = (res as any).message || message;
        errors = (res as any).errors;
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

    // Log error for debugging
    console.error('Exception caught:', {
      message,
      errorCode,
      status,
      path: request.url,
      method: request.method,
      stack: exception instanceof Error ? exception.stack : undefined,
    });

    const errorResponse: any = {
      success: false,
      errorCode,
      message,
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    // Include validation errors if present
    if (errors) {
      errorResponse.errors = errors;
    }

    response.status(status).json(errorResponse);
  }
}
