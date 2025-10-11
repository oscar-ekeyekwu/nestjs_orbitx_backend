import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
  WsException,
} from '@nestjs/websockets';

import { UseGuards } from '@nestjs/common';
import { Server } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { WsJwtGuard } from '../auth/guards/ws-jwt.guard';
import type { AuthenticatedSocket } from '../auth/guards/ws-jwt.guard';
import { OrdersService } from '../orders/orders.service';
import { DriversService } from '../drivers/drivers.service';

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  /**
   * Tracks connected users and their socket IDs.
   * Key: userId, Value: socketId
   */
  private readonly userSockets = new Map<string, string>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly ordersService: OrdersService,
    private readonly driversService: DriversService,
  ) {}

  // --------------------------------------------------------------------------
  // Connection Lifecycle Events
  // --------------------------------------------------------------------------

  async handleConnection(client: AuthenticatedSocket): Promise<void> {
    try {
      const rawToken =
        client.handshake?.auth?.token ||
        (typeof client.handshake?.headers?.authorization === 'string'
          ? client.handshake.headers.authorization
          : Array.isArray(client.handshake?.headers?.authorization)
            ? client.handshake.headers.authorization[0]
            : undefined);

      if (!rawToken) {
        client.emit('auth_error', { message: 'Authentication token missing' });
        client.disconnect(true);
        return;
      }

      const token = rawToken.startsWith('Bearer ')
        ? rawToken.split(' ')[1]
        : rawToken;

      const payload = this.jwtService.verify<{ sub: string; role: string }>(
        token,
      );

      // Attach user info to the socket
      client.userId = payload.sub;
      client.userRole = payload.role;

      // Save to connected user map
      this.userSockets.set(payload.sub, client.id);

      console.log(
        `✅ Client connected: ${client.id}, User: ${client.userId}, Role: ${client.userRole}`,
      );

      // Join a private room for this user
      client.join(`user:${client.userId}`);
      await Promise.resolve(); // placeholder to satisfy eslint
    } catch (error) {
      console.error('❌ Connection auth error:', error);
      client.emit('auth_error', { message: 'Invalid or expired token' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthenticatedSocket): void {
    if (client.userId) {
      this.userSockets.delete(client.userId);
      console.log(
        `❎ Client disconnected: ${client.id}, User: ${client.userId}`,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Socket Event Handlers
  // --------------------------------------------------------------------------

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('join_order')
  handleJoinOrder(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { orderId: string },
  ) {
    if (!data.orderId) {
      throw new WsException('orderId is required');
    }

    client.join(`order:${data.orderId}`);
    return { success: true, message: `Joined order ${data.orderId}` };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('leave_order')
  handleLeaveOrder(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { orderId: string },
  ) {
    if (!data.orderId) {
      throw new WsException('orderId is required');
    }

    client.leave(`order:${data.orderId}`);
    return { success: true, message: `Left order ${data.orderId}` };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('update_driver_location')
  async handleDriverLocationUpdate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: { orderId: string; latitude: number; longitude: number },
  ) {
    if (!data.orderId || data.latitude == null || data.longitude == null) {
      throw new WsException('Invalid driver location payload');
    }

    try {
      await this.ordersService.updateDriverLocation(
        data.orderId,
        data.latitude,
        data.longitude,
      );

      if (client.userId) {
        await this.driversService.updateLocation(
          client.userId,
          data.latitude,
          data.longitude,
        );
      }

      this.emitToOrder(data.orderId, 'driver_location_updated', {
        orderId: data.orderId,
        latitude: data.latitude,
        longitude: data.longitude,
      });

      return { success: true };
    } catch (error: any) {
      console.error('🚨 Location update error:', error);
      return { success: false, error: error as string };
    }
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('send_message')
  handleMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { orderId: string; message: string },
  ) {
    if (!data.orderId || !data.message) {
      throw new WsException('orderId and message are required');
    }

    this.emitToOrder(data.orderId, 'new_message', {
      orderId: data.orderId,
      userId: client.userId,
      message: data.message,
    });

    return { success: true };
  }

  // --------------------------------------------------------------------------
  // Internal Emit Helpers
  // --------------------------------------------------------------------------

  private emitToOrder(
    orderId: string,
    event: string,
    data: Record<string, any>,
  ): void {
    this.server.to(`order:${orderId}`).emit(event, {
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  private emitToUser(
    userId: string,
    event: string,
    data: Record<string, any>,
  ): void {
    const socketId = this.userSockets.get(userId);
    if (socketId) {
      this.server.to(socketId).emit(event, {
        ...data,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Public Emit API (usable by other services)
  // --------------------------------------------------------------------------

  emitOrderStatusUpdate(orderId: string, status: string, order: object): void {
    this.emitToOrder(orderId, 'order_status_updated', {
      orderId,
      status,
      order,
    });
  }

  emitNewOrderToDrivers(order: object): void {
    this.server.emit('new_order_available', {
      order,
      timestamp: new Date().toISOString(),
    });
  }

  emitOrderAccepted(orderId: string, customerId: string, driver: object): void {
    this.emitToUser(customerId, 'order_accepted', { orderId, driver });
  }

  notifyUser(userId: string, event: string, data: Record<string, any>): void {
    this.emitToUser(userId, event, data);
  }
}
