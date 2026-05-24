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

import { Inject, Logger, UseGuards, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
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

  private readonly logger = new Logger(RealtimeGateway.name);

  /**
   * Tracks connected users and their socket IDs.
   * Key: userId, Value: socketId
   */
  private readonly userSockets = new Map<string, string>();

  constructor(
    private readonly jwtService: JwtService,
    // OrdersService is in a forwardRef'd module — the @Inject + forwardRef
    // pair is required for Nest to wire the circular dep at runtime.
    @Inject(forwardRef(() => OrdersService))
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

      // Join a private room for this user.
      // socket.io v4 returns Promise<void>; await so connection auth completes deterministically.
      await client.join(`user:${client.userId}`);
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

    void client.join(`order:${data.orderId}`);
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

    void client.leave(`order:${data.orderId}`);
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

  /**
   * PAY-1 — wallet-funding nudge. Paystack webhook handler emits
   * `wallet.funded` after addFunds commits; this listener forwards
   * the payload to the user's socket room (joined at handshake) so
   * the mobile wallet screen can refresh balance + transactions
   * without waiting for a pull-to-refresh.
   */
  @OnEvent('wallet.funded')
  onWalletFunded(event: {
    userId: string;
    amountNaira: number;
    reference: string;
  }): void {
    this.emitToUser(event.userId, 'wallet.funded', {
      amountNaira: event.amountNaira,
      reference: event.reference,
    });
  }

  /**
   * Driver online-state reconcile. Emitted by any backend path that
   * flips driver_profiles.isOnline — the driver's own toggle, admin
   * suspension, or doc-expiry re-review. Forwarded to the driver's
   * socket so the mobile UI updates in real time without polling.
   * Mobile listener (useSocketEvents) calls driverStore.hydrateStatus.
   */
  @OnEvent('driver.status')
  onDriverStatus(event: {
    userId: string;
    isOnline: boolean;
    isOnDelivery: boolean;
  }): void {
    this.emitToUser(event.userId, 'driver.status', {
      isOnline: event.isOnline,
      isOnDelivery: event.isOnDelivery,
    });
  }

  emitNewOrderToDrivers(order: object): void {
    this.server.emit('new_order_available', {
      order,
      timestamp: new Date().toISOString(),
    });
  }

  // --------------------------------------------------------------------------
  // ARCH-12 — eligible-driver room semantics
  // --------------------------------------------------------------------------

  /**
   * Build the deterministic room name used for order-offered broadcasts.
   * Keyed on the package size so a motorcycle-only driver never sees
   * truck-sized orders. Region is hard-coded to `lagos` in v1; v1.1
   * widens this when the second city ships.
   */
  static eligibleRoom(packageSize: string): string {
    return `drivers:eligible:lagos:${packageSize}`;
  }

  /**
   * ARCH-12 — when a driver flips isOnline=true their currently-connected
   * socket joins the rooms matching their vehicle's capacity. Returns
   * the rooms actually joined (useful for logging + tests).
   */
  joinDriverToEligibleRooms(
    userId: string,
    packageSizes: readonly string[],
  ): string[] {
    const socketId = this.userSockets.get(userId);
    if (!socketId) return [];
    const socket = this.server.sockets.sockets.get(socketId);
    if (!socket) return [];
    const rooms = packageSizes.map((s) => RealtimeGateway.eligibleRoom(s));
    rooms.forEach((room) => void socket.join(room));
    return rooms;
  }

  /**
   * ARCH-12 — when a driver flips isOnline=false (or disconnects). Leaves
   * every eligible-room the socket is currently in.
   */
  leaveDriverFromEligibleRooms(userId: string): string[] {
    const socketId = this.userSockets.get(userId);
    if (!socketId) return [];
    const socket = this.server.sockets.sockets.get(socketId);
    if (!socket) return [];
    const eligibleRooms = [...socket.rooms].filter((r) =>
      r.startsWith('drivers:eligible:lagos:'),
    );
    eligibleRooms.forEach((room) => void socket.leave(room));
    return eligibleRooms;
  }

  /**
   * J4 — count of connected sockets in the eligible room for a given
   * package size. Used by `OrdersService.create` to stamp
   * `orders.eligibleDriversAtBroadcast` for the order-matching report.
   * Returns 0 if the server isn't initialised yet (CLI run / unit tests).
   */
  async countEligibleDrivers(packageSize: string): Promise<number> {
    if (!this.server) return 0;
    const room = RealtimeGateway.eligibleRoom(packageSize);
    const sockets = await this.server.in(room).fetchSockets();
    return sockets.length;
  }

  /**
   * ARCH-12 — fan out a freshly-created order to every driver in the
   * matching eligible room. Returns the room name for logging.
   */
  emitOrderOffered(packageSize: string, order: object): string {
    const room = RealtimeGateway.eligibleRoom(packageSize);
    this.server.to(room).emit('order_offered', {
      order,
      timestamp: new Date().toISOString(),
    });
    // Best-effort visibility into how many sockets actually got the
    // broadcast. If this is 0 every time, the driver mobile never
    // joined the room — most often because the socket connected
    // before the driver flipped isOnline=true, or the driver's
    // vehicle type doesn't cover this packageSize.
    void this.server
      .in(room)
      .fetchSockets()
      .then((sockets) => {
        this.logger.log(
          `order_offered → room=${room} sockets=${sockets.length}`,
        );
      })
      .catch(() => undefined);
    return room;
  }

  /**
   * ARCH-12 — fan out an order_taken event to the same room so the
   * losing drivers' UIs drop the order from their available list. Sent
   * alongside the customer's `order_accepted` event from acceptOrder.
   */
  emitOrderTaken(packageSize: string, orderId: string): string {
    const room = RealtimeGateway.eligibleRoom(packageSize);
    this.server.to(room).emit('order_taken', {
      orderId,
      timestamp: new Date().toISOString(),
    });
    return room;
  }

  emitOrderAccepted(orderId: string, customerId: string, driver: object): void {
    this.emitToUser(customerId, 'order_accepted', { orderId, driver });
  }

  notifyUser(userId: string, event: string, data: Record<string, any>): void {
    this.emitToUser(userId, event, data);
  }
}
