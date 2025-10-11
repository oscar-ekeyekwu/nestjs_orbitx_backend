// ../auth/decorators/current-user.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
  (data: keyof any | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // If you pass a specific key, e.g. @CurrentUser('email'),
    // it will return only that property
    return data ? user?.[data] : user;
  },
);
