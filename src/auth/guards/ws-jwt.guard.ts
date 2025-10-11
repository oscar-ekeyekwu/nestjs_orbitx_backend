import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

interface JwtPayload {
  sub: string;
  role: string;
  email?: string;
}

/**
 * Use Socket['handshake'] as the base to preserve all existing fields
 * that socket.io provides. Then extend it with the optional `auth`
 * and a headers augmentation that allows an `authorization` field.
 *
 * NOTE: `headers` must remain compatible with the base type (IncomingHttpHeaders),
 * so we intersect with BaseHandshake['headers'] and add an optional `authorization`
 * key to that object — we DO NOT make `headers` itself optional.
 */
type BaseHandshake = Socket['handshake'];

interface ExtendedHandshake extends BaseHandshake {
  // `auth` is optional; many clients put tokens here with socket.io v3+ client
  auth: {
    token?: string;
    [key: string]: any;
  };

  // Keep the original headers shape, but indicate `authorization` may exist.
  // We keep `headers` non-optional to remain compatible with the original Handshake type.
  headers: BaseHandshake['headers'] & {
    authorization?: string | string[];
    [key: string]: any;
  };
}

export interface AuthenticatedSocket extends Socket {
  handshake: ExtendedHandshake;
  userId?: string;
  userRole?: string;
  userEmail?: string;
}

@Injectable()
export class WsJwtGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<AuthenticatedSocket>();
    const tokenFromAuth = client.handshake.auth?.token;
    const tokenFromHeader = client.handshake.headers?.authorization;

    const rawToken = tokenFromAuth || tokenFromHeader;

    if (!rawToken) {
      throw new WsException('Missing authentication token');
    }

    const token = rawToken.startsWith('Bearer ')
      ? rawToken.split(' ')[1]
      : rawToken;

    try {
      const payload = this.jwtService.verify<JwtPayload>(token);

      // Attach decoded payload data to client
      client.userId = payload.sub;
      client.userRole = payload.role;
      client.userEmail = payload.email;

      return true;
    } catch {
      throw new WsException('Invalid or expired token');
    }
  }
}
