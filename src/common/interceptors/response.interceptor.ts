import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ResponseFormat<T> {
  success: boolean;
  message: string;
  data: T;
}

@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, ResponseFormat<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ResponseFormat<T>> {
    return next.handle().pipe(
      map((response) => {
        // If controller returns already wrapped response, don't double-wrap
        if (response && typeof response === 'object' && 'success' in response) {
          return response;
        }

        // Default wrapping
        return {
          success: true,
          message: 'Request successful',
          data: response ?? null,
        };
      }),
    );
  }
}
