// ../auth/decorators/current-user.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../../users/entities/user.entity';

type AuthenticatedRequest = Request & { user?: User };

export const CurrentUser = createParamDecorator(
  (data: keyof User | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    // If you pass a specific key, e.g. @CurrentUser('email'),
    // it will return only that property
    return data ? user?.[data] : user;
  },
);
