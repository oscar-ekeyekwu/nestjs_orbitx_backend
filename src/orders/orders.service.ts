import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { Order, OrderStatus, PackageSize } from './entities/order.entity';
import { ErrorCodes } from '../common/constants/error-codes';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UserRole } from '../common/enums/user-role.enum';
import { WalletService } from '../wallet/wallet.service';
import { SystemConfigService } from '../config/config.service';
import { ConfigKey } from '../config/enums/config-keys.enum';
import { PaymentMethod } from '../wallet/entities/transaction.entity';
import {
  PaginatedResult,
  createPaginatedResponse,
} from '../common/dto/pagination.dto';
import { GetOrdersQueryDto } from './dto/get-orders-query.dto';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notification.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { User } from '../users/entities/user.entity';
import Decimal from 'decimal.js';
import { Naira, naira } from '../common/money';
import { haversineKm } from '../common/geo';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    private walletService: WalletService,
    private configService: SystemConfigService,
    // forwardRef because RealtimeGateway (in RealtimeModule) also depends on OrdersService.
    @Inject(forwardRef(() => RealtimeGateway))
    private realtimeGateway: RealtimeGateway,
    // forwardRef because NotificationsModule → RealtimeModule → OrdersModule
    // forms a cycle; the module import is also forwardRef'd in orders.module.ts.
    @Inject(forwardRef(() => NotificationsService))
    private notifications: NotificationsService,
    // E4 — receipts pipeline. Best-effort fire on DELIVERED; failures
    // are logged but never roll back the status transition.
    private readonly receipts: ReceiptsService,
    private readonly dataSource: DataSource,
    // F2 — lazy-resolved so legacy specs that construct OrdersService
    // directly (without the vehicles module wired up) still run. When
    // ModuleRef is undefined the lock-mode gate is a no-op, which is
    // also the correct production behaviour when VEHICLE_EDIT_GRACE_MODE
    // is `continue` (the default).
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * Build the recipient descriptor the NotificationsService expects from a
   * User entity. fcmToken is intentionally absent — User doesn't yet store
   * one, and the dispatcher skips push when missing.
   */
  private recipient(user: User) {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      name: user.name,
    };
  }

  /**
   * Best-effort notification dispatch. A notification failure must never
   * surface as a 500 to the caller — log and continue.
   */
  private async safeNotify(
    label: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      console.error(`Notification dispatch failed (${label}):`, error);
    }
  }

  /**
   * Realtime emit failures must never roll back a successful DB write.
   * Wrap every gateway call so transport errors are logged and swallowed.
   */
  private safeEmit(action: () => void, label: string): void {
    try {
      action();
    } catch (error) {
      console.error(`Realtime emit failed (${label}):`, error);
    }
  }

  async create(
    createOrderDto: CreateOrderDto,
    customerId: string,
  ): Promise<Order> {
    const estimatedPrice = await this.calculatePrice(
      createOrderDto.pickupLatitude,
      createOrderDto.pickupLongitude,
      createOrderDto.deliveryLatitude,
      createOrderDto.deliveryLongitude,
      createOrderDto.packageSize,
    );

    const order = this.ordersRepository.create({
      ...createOrderDto,
      customerId,
      estimatedPrice,
      status: OrderStatus.PENDING,
    });

    const savedOrder = await this.ordersRepository.save(order);

    // ARCH-12 — narrow the broadcast to the eligible-drivers room
    // keyed on packageSize so a motorcycle driver isn't woken up for
    // a truck-sized parcel. The legacy global `new_order_available`
    // emit stays for now (admin dashboards still listen on it) but
    // graduates to deprecation once the mobile clients ship the
    // `order_offered` subscription.
    this.safeEmit(
      () =>
        this.realtimeGateway.emitOrderOffered(
          savedOrder.packageSize,
          savedOrder,
        ),
      'order_offered',
    );
    this.safeEmit(
      () => this.realtimeGateway.emitNewOrderToDrivers(savedOrder),
      'new_order_available',
    );

    const withCustomer = await this.ordersRepository.findOne({
      where: { id: savedOrder.id },
      relations: ['customer'],
    });
    if (withCustomer?.customer) {
      await this.safeNotify('order_created', () =>
        this.notifications.notifyOrderCreated(
          withCustomer,
          this.recipient(withCustomer.customer),
        ),
      );
    }

    return savedOrder;
  }

  async findAll(
    userId: string,
    userRole: UserRole,
    queryDto: GetOrdersQueryDto,
  ): Promise<PaginatedResult<Order>> {
    const { status } = queryDto;
    const query = this.ordersRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.customer', 'customer')
      .leftJoinAndSelect('order.driver', 'driver');

    if (userRole === UserRole.CUSTOMER) {
      query.where('order.customerId = :userId', { userId });
    } else if (userRole === UserRole.DRIVER) {
      query.where('order.driverId = :userId', { userId });
    }

    if (status) {
      query.andWhere('order.status = :status', { status });
    }

    query
      .orderBy('order.createdAt', 'DESC')
      .skip(queryDto.skip)
      .take(queryDto.limit);

    const [orders, total] = await query.getManyAndCount();

    return createPaginatedResponse(
      orders,
      total,
      queryDto.page!,
      queryDto.limit!,
    );
  }

  async findAvailableOrders(
    driverLat: number,
    driverLng: number,
  ): Promise<Order[]> {
    // Get delivery radius from config
    const deliveryRadiusKm = await this.configService.getNumber(
      ConfigKey.ORDER_DELIVERY_RADIUS_KM,
      50,
    );

    // Find pending orders
    const orders = await this.ordersRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.customer', 'customer')
      .where('order.status = :status', { status: OrderStatus.PENDING })
      .orderBy('order.createdAt', 'ASC')
      .getMany();

    // Calculate distance and filter by configured radius
    return orders
      .map((order) => ({
        ...order,
        distance: this.calculateDistance(
          driverLat,
          driverLng,
          order.pickupLatitude,
          order.pickupLongitude,
        ),
      }))
      .filter((order) => order.distance <= deliveryRadiusKm)
      .sort((a, b) => a.distance - b.distance);
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: ['customer', 'driver'],
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return order;
  }

  /**
   * Caller-scoped variant of `findOne`. Customers can only fetch orders
   * they placed; drivers can only fetch orders they were assigned to;
   * admins always pass. Throws ForbiddenException with no distinguishing
   * message between "not found" and "not yours" so the endpoint can't
   * be used to probe for valid order ids belonging to someone else.
   *
   * E2 — gates exposure of `driver.phone` to a customer who is not the
   * order owner (the relation loads driver info that the controller
   * serializes to the caller).
   */
  async findOneScoped(
    id: string,
    callerUserId: string,
    callerRole: UserRole,
  ): Promise<Order> {
    const order = await this.findOne(id);

    if (callerRole === UserRole.ADMIN) {
      return order;
    }
    if (callerRole === UserRole.CUSTOMER && order.customerId === callerUserId) {
      return order;
    }
    if (callerRole === UserRole.DRIVER && order.driverId === callerUserId) {
      return order;
    }

    throw new ForbiddenException('Not authorized to view this order');
  }

  async acceptOrder(orderId: string, driverId: string): Promise<Order> {
    // Balance gate runs BEFORE the lock so a broke driver doesn't hold
    // the row open while the wallet check runs.
    const canTakeOrder = await this.walletService.canDriverTakeOrder(driverId);
    if (!canTakeOrder) {
      const minBalance = await this.configService.getNumber(
        ConfigKey.DRIVER_MIN_BALANCE,
        0,
      );
      throw new BadRequestException(
        `Insufficient balance. Minimum balance of ₦${minBalance} required to accept orders`,
      );
    }

    // F2 — lock-mode gate. If VEHICLE_EDIT_GRACE_MODE=lock and the
    // driver's active vehicle has a pending regulatory edit awaiting
    // admin review, refuse acceptance with VEHICLE_002. continue mode
    // (the default) skips this entirely.
    await this.assertNoVehicleEditLock(driverId);

    // ARCH-12 — first-accept-wins via pessimistic_write on the order
    // row. Two concurrent acceptOrder calls serialize at the DB; the
    // second transaction's findOne sees status=ACCEPTED and throws
    // ORDER_004 instead of silently overwriting driverId.
    const acceptedOrder = await this.dataSource.transaction(async (manager) => {
      const locked = await manager.findOne(Order, {
        where: { id: orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) {
        throw new NotFoundException('Order not found');
      }
      if (locked.status !== OrderStatus.PENDING) {
        throw new BadRequestException({
          errorCode: ErrorCodes.ORDER_004,
          message: 'Order has already been accepted by another driver.',
        });
      }
      locked.driverId = driverId;
      locked.status = OrderStatus.ACCEPTED;
      locked.acceptedAt = new Date();
      await manager.save(locked);
      return manager.findOne(Order, {
        where: { id: orderId },
        relations: ['customer', 'driver'],
      });
    });

    // Deduct security deposit AFTER the lock releases. If this fails,
    // the order is still validly accepted; the wallet error surfaces to
    // the caller and an oncall reviewer reconciles. Inverting the order
    // (deduct first then save) would risk taking money from a driver
    // whose lock attempt loses, which is much worse.
    await this.walletService.deductSecurityDeposit(driverId, orderId);

    if (acceptedOrder) {
      // ARCH-12 — fan out order_taken so other drivers in the eligible
      // room drop the order from their available list. Sent BEFORE the
      // customer notification so the losing drivers don't see a stale
      // "available" entry while the customer toast fires.
      this.safeEmit(
        () =>
          this.realtimeGateway.emitOrderTaken(
            acceptedOrder.packageSize,
            orderId,
          ),
        'order_taken',
      );

      // Notify the customer directly that their order was accepted, including driver info.
      this.safeEmit(
        () =>
          this.realtimeGateway.emitOrderAccepted(
            orderId,
            acceptedOrder.customerId,
            acceptedOrder.driver,
          ),
        'order_accepted',
      );

      // Also broadcast the status change into the order's room so any
      // subscriber (customer tracking, dashboards) sees the transition.
      this.safeEmit(
        () =>
          this.realtimeGateway.emitOrderStatusUpdate(
            orderId,
            acceptedOrder.status,
            acceptedOrder,
          ),
        'order_status_updated:accepted',
      );

      if (acceptedOrder.customer && acceptedOrder.driver) {
        await this.safeNotify('order_accepted', () =>
          this.notifications.notifyOrderAccepted(
            acceptedOrder,
            this.recipient(acceptedOrder.customer),
            {
              id: acceptedOrder.driver.id,
              name: acceptedOrder.driver.name,
              phone: acceptedOrder.driver.phone ?? '',
            },
          ),
        );
      }
    }

    return acceptedOrder as Order;
  }

  async updateStatus(
    orderId: string,
    updateStatusDto: UpdateOrderStatusDto,
    userId: string,
    userRole: UserRole,
  ): Promise<Order> {
    const order = await this.findOne(orderId);

    // Validate permissions
    if (userRole === UserRole.CUSTOMER && order.customerId !== userId) {
      throw new ForbiddenException('Not authorized to update this order');
    }

    if (userRole === UserRole.DRIVER && order.driverId !== userId) {
      throw new ForbiddenException('Not authorized to update this order');
    }

    // Validate status transitions
    this.validateStatusTransition(order.status, updateStatusDto.status);

    order.status = updateStatusDto.status;

    // Update timestamps
    if (updateStatusDto.status === OrderStatus.PICKED_UP && !order.pickedUpAt) {
      order.pickedUpAt = new Date();
    }

    if (
      updateStatusDto.status === OrderStatus.DELIVERED &&
      !order.deliveredAt
    ) {
      order.deliveredAt = new Date();
      order.finalPrice = order.estimatedPrice;

      if (order.driverId) {
        // Refund security deposit first, then credit earnings
        await this.walletService.refundSecurityDeposit(
          order.driverId,
          order.id,
        );
        await this.walletService.processOrderPayment(
          order.driverId,
          order.id,
          order.finalPrice,
          PaymentMethod.CASH,
        );
      }
    }

    const savedOrder = await this.ordersRepository.save(order);

    // Broadcast status change to anyone watching this order (customer tracking screen, etc.)
    this.safeEmit(
      () =>
        this.realtimeGateway.emitOrderStatusUpdate(
          orderId,
          savedOrder.status,
          savedOrder,
        ),
      `order_status_updated:${savedOrder.status}`,
    );

    if (order.customer) {
      const recipient = this.recipient(order.customer);
      switch (savedOrder.status) {
        case OrderStatus.PICKED_UP:
          await this.safeNotify('order_picked_up', () =>
            this.notifications.notifyOrderPickedUp(savedOrder, recipient),
          );
          break;
        case OrderStatus.IN_TRANSIT:
          await this.safeNotify('order_in_transit', () =>
            this.notifications.notifyOrderInTransit(savedOrder, recipient),
          );
          break;
        case OrderStatus.DELIVERED:
          await this.safeNotify('order_delivered', () =>
            this.notifications.notifyOrderDelivered(savedOrder, recipient),
          );
          // E4 — receipt is best-effort; if S3 / SMS / SMTP are down,
          // the customer still gets the existing in-app delivery
          // notification and an oncall reviewer can replay later.
          await this.safeNotify('order_receipt', () =>
            this.receipts.generateForOrder(savedOrder.id).then(() => undefined),
          );
          break;
        default:
          break;
      }
    }

    return savedOrder;
  }

  async updateDriverLocation(
    orderId: string,
    latitude: number,
    longitude: number,
  ): Promise<Order> {
    const order = await this.findOne(orderId);

    order.driverLatitude = latitude;
    order.driverLongitude = longitude;

    return this.ordersRepository.save(order);
  }

  async cancelOrder(
    orderId: string,
    userId: string,
    userRole: UserRole,
  ): Promise<Order> {
    const order = await this.findOne(orderId);

    // Only customer can cancel before acceptance, driver can cancel after
    if (userRole === UserRole.CUSTOMER && order.customerId !== userId) {
      throw new ForbiddenException('Not authorized to cancel this order');
    }

    if (userRole === UserRole.DRIVER && order.driverId !== userId) {
      throw new ForbiddenException('Not authorized to cancel this order');
    }

    if (order.status === OrderStatus.DELIVERED) {
      throw new BadRequestException('Cannot cancel delivered order');
    }

    // Refund security deposit if order was already accepted
    if (order.driverId && order.status !== OrderStatus.PENDING) {
      await this.walletService.refundSecurityDeposit(order.driverId, orderId);
    }

    order.status = OrderStatus.CANCELLED;
    const savedOrder = await this.ordersRepository.save(order);

    this.safeEmit(
      () =>
        this.realtimeGateway.emitOrderStatusUpdate(
          orderId,
          savedOrder.status,
          savedOrder,
        ),
      'order_status_updated:cancelled',
    );

    if (order.customer) {
      await this.safeNotify('order_cancelled', () =>
        this.notifications.notifyOrderCancelled(
          savedOrder,
          this.recipient(order.customer),
        ),
      );
    }

    return savedOrder;
  }

  private validateStatusTransition(
    currentStatus: OrderStatus,
    newStatus: OrderStatus,
  ): void {
    const validTransitions: Record<OrderStatus, OrderStatus[]> = {
      [OrderStatus.PENDING]: [OrderStatus.ACCEPTED, OrderStatus.CANCELLED],
      [OrderStatus.ACCEPTED]: [OrderStatus.PICKED_UP, OrderStatus.CANCELLED],
      [OrderStatus.PICKED_UP]: [OrderStatus.IN_TRANSIT, OrderStatus.CANCELLED],
      [OrderStatus.IN_TRANSIT]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
      [OrderStatus.DELIVERED]: [],
      [OrderStatus.CANCELLED]: [],
    };

    if (!validTransitions[currentStatus]?.includes(newStatus)) {
      throw new BadRequestException(
        `Cannot transition from ${currentStatus} to ${newStatus}`,
      );
    }
  }

  private async calculatePrice(
    pickupLat: number,
    pickupLng: number,
    deliveryLat: number,
    deliveryLng: number,
    packageSize: PackageSize,
  ): Promise<Naira> {
    const distance = this.calculateDistance(
      pickupLat,
      pickupLng,
      deliveryLat,
      deliveryLng,
    );

    // Get pricing configuration
    const basePrice = await this.configService.getNumber(
      ConfigKey.ORDER_BASE_PRICE,
      1000,
    );
    const pricePerKm = await this.configService.getNumber(
      ConfigKey.ORDER_PRICE_PER_KM,
      100,
    );

    const sizeMultiplier = {
      [PackageSize.SMALL]: await this.configService.getNumber(
        ConfigKey.PACKAGE_SIZE_SMALL_MULTIPLIER,
        1,
      ),
      [PackageSize.MEDIUM]: await this.configService.getNumber(
        ConfigKey.PACKAGE_SIZE_MEDIUM_MULTIPLIER,
        1.5,
      ),
      [PackageSize.LARGE]: await this.configService.getNumber(
        ConfigKey.PACKAGE_SIZE_LARGE_MULTIPLIER,
        2,
      ),
    };

    // Compute in Decimal to preserve kobo precision; round to the nearest
    // naira (scale 0) for the customer-facing estimate.
    const distancePrice = naira(String(distance)).times(pricePerKm);
    const totalPrice = naira(String(basePrice))
      .plus(distancePrice)
      .times(sizeMultiplier[packageSize]);

    return totalPrice.toDecimalPlaces(0, Decimal.ROUND_HALF_UP) as Naira;
  }

  private calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    return haversineKm(lat1, lon1, lat2, lon2);
  }

  /**
   * F2 lock-mode gate — refuses acceptance when the driver's active
   * vehicle has a pending regulatory edit and
   * VEHICLE_EDIT_GRACE_MODE=lock. No-op when the moduleRef isn't
   * wired (legacy specs) or no active assignment exists.
   *
   * Resolution is lazy on purpose: VehicleAssignment + the pending
   * updates service live in VehiclesModule, which OrdersModule does
   * not statically import (avoiding another cycle). Using ModuleRef
   * keeps the wiring contained to this single helper.
   */
  private async assertNoVehicleEditLock(driverId: string): Promise<void> {
    if (!this.moduleRef) return;

    type AssignmentRepo = {
      findOne: (opts: unknown) => Promise<{ vehicleId: string } | null>;
    };
    type PendingService = {
      checkAcceptanceBlock: (vehicleId: string) => Promise<string | null>;
    };

    let assignmentRepo: AssignmentRepo | null = null;
    let pendingService: PendingService | null = null;
    try {
      assignmentRepo = this.moduleRef.get<AssignmentRepo>(
        'VehicleAssignmentRepository' as never,
        { strict: false },
      );
      pendingService = this.moduleRef.get<PendingService>(
        'VehiclePendingUpdatesService' as never,
        { strict: false },
      );
    } catch {
      return;
    }
    if (!assignmentRepo || !pendingService) return;

    const assignment = await assignmentRepo.findOne({
      where: { driverId, unassignedAt: IsNull() },
      order: { assignedAt: 'DESC' },
    });
    if (!assignment) return;

    const block = await pendingService.checkAcceptanceBlock(
      assignment.vehicleId,
    );
    if (block) {
      throw new BadRequestException({
        errorCode: block,
        message:
          'Vehicle change under review — you cannot accept orders until approved.',
      });
    }
  }
}
