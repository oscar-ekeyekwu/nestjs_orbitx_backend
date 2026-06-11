import {
  Injectable,
  Logger,
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
import {
  Order,
  OrderPaymentStatus,
  OrderStatus,
  PackageSize,
} from './entities/order.entity';
import { ErrorCodes } from '../common/constants/error-codes';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UserRole } from '../common/enums/user-role.enum';
import { WalletService } from '../wallet/wallet.service';
import { SystemConfigService } from '../config/config.service';
import { ConfigKey } from '../config/enums/config-keys.enum';
import { assertInsideLagos, assertInsideNigeria } from '../common/geo';
import { PaymentMethod } from '../wallet/entities/transaction.entity';
import {
  ApprovalAction,
  ApprovalDecision,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
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
import { NAIRA_ZERO, Naira, naira } from '../common/money';
import { haversineKm } from '../common/geo';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  /**
   * In-memory throttle for the rebroadcast endpoint. Keys are
   * `${orderId}`, values are the last-broadcast epoch millis. We
   * accept that this resets on restart — the only goal is to stop
   * accidental double-taps + abusive polling; a stale state for a
   * few seconds post-restart is acceptable for a UX guard.
   */
  private static readonly REBROADCAST_COOLDOWN_MS = 30_000;
  private readonly lastBroadcastAt = new Map<string, number>();

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
    private readonly eventEmitter: EventEmitter2,
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
    // J2 — sanity-check pickup + dropoff against the Nigeria bbox first
    // so we surface GEO_001 (out of region) before the narrower ZONE_001.
    assertInsideNigeria(
      createOrderDto.pickupLatitude,
      createOrderDto.pickupLongitude,
    );
    assertInsideNigeria(
      createOrderDto.deliveryLatitude,
      createOrderDto.deliveryLongitude,
    );

    // I5 — both endpoints must fall inside the Lagos service zone.
    await assertInsideLagos(
      createOrderDto.pickupLatitude,
      createOrderDto.pickupLongitude,
      this.configService,
    );
    await assertInsideLagos(
      createOrderDto.deliveryLatitude,
      createOrderDto.deliveryLongitude,
      this.configService,
    );

    const estimatedPrice = await this.calculatePrice(
      createOrderDto.pickupLatitude,
      createOrderDto.pickupLongitude,
      createOrderDto.deliveryLatitude,
      createOrderDto.deliveryLongitude,
      createOrderDto.packageSize,
    );

    // Snapshot the insurance fee at create time. Stored on the order
    // so retroactive admin changes to the fee config never rewrite
    // historical settlements.
    const insuranceFee = await this.calculateInsuranceFee(estimatedPrice);

    // Snapshot the per-order platform charge (flat or capped percentage)
    // at create time too. This single value gates driver visibility, the
    // accept-time balance check, and the wallet hold — all read from the
    // order so a later config change never rewrites an in-flight order.
    const platformCharge =
      await this.walletService.computeOrderCharge(estimatedPrice);

    // G2 / G3 — payment method ships as part of the create DTO; default
    // to CASH so v0 clients (which don't send the field) keep working.
    //   cash          → pending_cash     (driver collects)
    //   bank_transfer → pending_transfer (admin reconciles)
    //   anything else → pending          (Paystack webhook closes it)
    const paymentMethod = createOrderDto.paymentMethod ?? PaymentMethod.CASH;
    const paymentStatus =
      paymentMethod === PaymentMethod.CASH
        ? OrderPaymentStatus.PENDING_CASH
        : paymentMethod === PaymentMethod.BANK_TRANSFER
          ? OrderPaymentStatus.PENDING_TRANSFER
          : OrderPaymentStatus.PENDING;

    // J4 — sample the eligible-driver pool size at broadcast time so
    // we can answer "was the room too thin?" when an order ages out.
    // Best-effort: a query failure here must NOT block the order create.
    let eligibleAtBroadcast: number | null = null;
    try {
      const eligible = await this.realtimeGateway.countEligibleDrivers(
        createOrderDto.packageSize,
      );
      eligibleAtBroadcast = eligible;
    } catch {
      eligibleAtBroadcast = null;
    }

    const order = this.ordersRepository.create({
      ...createOrderDto,
      customerId,
      estimatedPrice,
      insuranceFee,
      platformCharge,
      status: OrderStatus.PENDING,
      paymentMethod,
      paymentStatus,
      eligibleDriversAtBroadcast: eligibleAtBroadcast,
    });

    const savedOrder = await this.ordersRepository.save(order);

    // Single observable line that ties order id → broadcast inputs.
    // Pair this with the realtime gateway's `order_offered → room=…
    // sockets=…` log and the push-fanout `order.created … fanning out
    // push to N driver(s)` log to debug "driver got nothing".
    this.logger.log(
      `Order created id=${savedOrder.id} packageSize=${savedOrder.packageSize} ` +
        `paymentStatus=${savedOrder.paymentStatus} eligibleAtBroadcast=${
          eligibleAtBroadcast ?? 'n/a'
        }`,
    );

    this.broadcastOrderToEligibleDrivers(savedOrder);
    this.lastBroadcastAt.set(savedOrder.id, Date.now());

    return savedOrder;
  }

  /**
   * Re-runs the socket + push fanout for an already-persisted PENDING
   * order. Used by the customer "Find driver again" affordance and by
   * the admin Orders detail page for ops. Idempotent across restarts.
   *
   * Guards:
   *   - Order must be in PENDING status (an accepted/delivered order
   *     can't be rebroadcast — that's a customer-confusion footgun).
   *   - Caller must be the order owner OR an admin.
   *   - 30-second cooldown per order to stop accidental double-taps.
   */
  async rebroadcast(
    orderId: string,
    actorUserId: string,
    actorRole: UserRole,
  ): Promise<{ orderId: string; broadcastAt: string }> {
    const order = await this.ordersRepository.findOne({
      where: { id: orderId },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const isOwner = order.customerId === actorUserId;
    const isAdmin = actorRole === UserRole.ADMIN;
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException(
        'Only the order owner or an admin can rebroadcast this order.',
      );
    }

    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException(
        `Cannot rebroadcast an order that is already ${order.status}.`,
      );
    }

    const last = this.lastBroadcastAt.get(orderId) ?? 0;
    const elapsedMs = Date.now() - last;
    if (elapsedMs < OrdersService.REBROADCAST_COOLDOWN_MS) {
      const remainingSec = Math.ceil(
        (OrdersService.REBROADCAST_COOLDOWN_MS - elapsedMs) / 1000,
      );
      throw new BadRequestException(
        `Please wait ${remainingSec}s before re-broadcasting this order.`,
      );
    }

    this.broadcastOrderToEligibleDrivers(order);
    const broadcastAt = new Date();
    this.lastBroadcastAt.set(orderId, broadcastAt.getTime());
    this.logger.log(
      `Order rebroadcast id=${orderId} actor=${actorUserId} role=${actorRole}`,
    );
    return { orderId, broadcastAt: broadcastAt.toISOString() };
  }

  /**
   * Three-step fanout (socket → legacy admin emit → push event)
   * used by both initial create() and rebroadcast(). Extracted so
   * both callers stay byte-identical and the push subscriber sees
   * the same event shape regardless of trigger.
   */
  private broadcastOrderToEligibleDrivers(order: Order): void {
    // ARCH-12 — narrow the broadcast to the eligible-drivers room
    // keyed on packageSize so a motorcycle driver isn't woken up for
    // a truck-sized parcel. The legacy global `new_order_available`
    // emit stays for now (admin dashboards still listen on it) but
    // graduates to deprecation once the mobile clients ship the
    // `order_offered` subscription.
    this.safeEmit(
      () =>
        this.realtimeGateway.emitOrderOffered(order.packageSize, order),
      'order_offered',
    );
    this.safeEmit(
      () => this.realtimeGateway.emitNewOrderToDrivers(order),
      'new_order_available',
    );

    void this.ordersRepository
      .findOne({ where: { id: order.id }, relations: ['customer'] })
      .then(async (withCustomer) => {
        if (withCustomer?.customer) {
          await this.safeNotify('order_created', () =>
            this.notifications.notifyOrderCreated(
              withCustomer,
              this.recipient(withCustomer.customer),
            ),
          );
        }
      })
      .catch((err) =>
        this.logger.error(`Customer notification fetch failed: ${err}`),
      );

    // Push fanout to eligible drivers. Socket broadcasts only reach
    // drivers whose app is foregrounded + connected; push reaches
    // everyone who's marked themselves online. Post-commit, fire-and-
    // forget — handler is in PushFanoutEventSubscribers.
    this.eventEmitter.emit('order.created', {
      orderId: order.id,
      packageSize: order.packageSize,
      pickupAddress: order.pickupAddress,
      deliveryAddress: order.deliveryAddress,
      estimatedPriceNaira: Number(order.estimatedPrice),
      // Proximity + balance dispatch inputs — the push subscriber filters
      // recipients to drivers within radius of the pickup whose wallet can
      // cover the charge.
      pickupLatitude: order.pickupLatitude,
      pickupLongitude: order.pickupLongitude,
      platformChargeNaira: Number(order.platformCharge ?? 0),
    });
  }

  /**
   * Pricing-only path used by the customer create-order screen to
   * show a live, distance-aware estimate as the user fills the form.
   * Reuses the same calculatePrice + calculateInsuranceFee helpers as
   * `create()` so the mobile preview can't drift from the persisted
   * value. Returns string-serialized Naira fields (matching the wire
   * format every other money-bearing response uses) plus the raw
   * great-circle distance for the UI.
   */
  async estimate(input: {
    pickupLatitude: number;
    pickupLongitude: number;
    deliveryLatitude: number;
    deliveryLongitude: number;
    packageSize: PackageSize;
  }): Promise<{
    estimatedPrice: string;
    insuranceFee: string | null;
    distanceKm: string;
  }> {
    const quote = await this.quote(input);
    return {
      estimatedPrice: quote.estimatedPrice.toString(),
      insuranceFee: quote.insuranceFee ? quote.insuranceFee.toString() : null,
      distanceKm: quote.distanceKm.toFixed(2),
    };
  }

  /**
   * Typed pricing helper shared by `estimate()` (mobile preview),
   * `create()` (persisted order), and the OrderRequest dispatch
   * flow. Single source of truth so a config tweak never produces
   * three different numbers across the three call sites.
   */
  async quote(input: {
    pickupLatitude: number;
    pickupLongitude: number;
    deliveryLatitude: number;
    deliveryLongitude: number;
    packageSize: PackageSize;
  }): Promise<{
    estimatedPrice: Naira;
    insuranceFee: Naira | null;
    platformCharge: Naira;
    distanceKm: number;
  }> {
    const distanceKm = this.calculateDistance(
      input.pickupLatitude,
      input.pickupLongitude,
      input.deliveryLatitude,
      input.deliveryLongitude,
    );
    const estimatedPrice = await this.calculatePrice(
      input.pickupLatitude,
      input.pickupLongitude,
      input.deliveryLatitude,
      input.deliveryLongitude,
      input.packageSize,
    );
    const insuranceFee = await this.calculateInsuranceFee(estimatedPrice);
    const platformCharge =
      await this.walletService.computeOrderCharge(estimatedPrice);
    return { estimatedPrice, insuranceFee, platformCharge, distanceKm };
  }

  async findAll(
    userId: string,
    userRole: UserRole,
    queryDto: GetOrdersQueryDto,
  ): Promise<PaginatedResult<Order>> {
    const { status, driverId } = queryDto;
    const query = this.ordersRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.customer', 'customer')
      .leftJoinAndSelect('order.driver', 'driver');

    if (userRole === UserRole.CUSTOMER) {
      query.where('order.customerId = :userId', { userId });
    } else if (userRole === UserRole.DRIVER) {
      query.where('order.driverId = :userId', { userId });
    } else if (userRole === UserRole.ADMIN && driverId) {
      // Admin-only driver scope, used by the DriverDetail cross-link.
      query.where('order.driverId = :driverId', { driverId });
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
    driverId: string,
  ): Promise<Order[]> {
    // Get delivery radius from config
    const deliveryRadiusKm = await this.configService.getNumber(
      ConfigKey.ORDER_DELIVERY_RADIUS_KM,
      50,
    );

    // Balance-gated visibility: a driver below an order's platform charge
    // must not see it. Load the wallet balance once and filter below.
    const wallet = await this.walletService.getWalletByUserId(driverId);
    const balance = wallet.balance;

    // G3 — exclude orders whose payment is still being arranged
    // off-platform (pending_transfer for manual bank transfer, plain
    // pending for Paystack pre-webhook). Cash orders pass through —
    // the driver collects in person. Reconciled orders (paymentStatus
    // = pending_cash | completed) become broadcast-eligible.
    const orders = await this.ordersRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.customer', 'customer')
      .where('order.status = :status', { status: OrderStatus.PENDING })
      .andWhere('order.paymentStatus NOT IN (:...blocked)', {
        blocked: [
          OrderPaymentStatus.PENDING,
          OrderPaymentStatus.PENDING_TRANSFER,
        ],
      })
      .orderBy('order.createdAt', 'ASC')
      .getMany();

    // Calculate distance, filter by configured radius, and hide orders the
    // driver can't afford (platformCharge null on pre-migration rows →
    // treated as 0 so they stay visible for back-compat).
    return orders
      .filter((order) =>
        (order.platformCharge ?? NAIRA_ZERO).lessThanOrEqualTo(balance),
      )
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
    // Per-order balance gate runs BEFORE the lock so a driver who can't
    // cover THIS order's charge doesn't hold the row open. Read the
    // snapshotted charge off the order (null on pre-migration rows →
    // treated as zero so the gate passes for back-compat).
    const chargeProbe = await this.ordersRepository.findOne({
      where: { id: orderId },
      select: ['id', 'platformCharge'],
    });
    if (!chargeProbe) {
      throw new NotFoundException('Order not found');
    }
    const orderCharge = chargeProbe.platformCharge ?? NAIRA_ZERO;
    const canCover = await this.walletService.canDriverCoverCharge(
      driverId,
      orderCharge,
    );
    if (!canCover) {
      throw new BadRequestException(
        `Insufficient wallet balance. ₦${orderCharge.toString()} required to accept this order.`,
      );
    }

    // F2 — lock-mode gate. If VEHICLE_EDIT_GRACE_MODE=lock and the
    // driver's active vehicle has a pending regulatory edit awaiting
    // admin review, refuse acceptance with VEHICLE_002. continue mode
    // (the default) skips this entirely.
    await this.assertNoVehicleEditLock(driverId);

    // J4 — fetch the driver's current location BEFORE the lock so the
    // metric capture inside the transaction is non-blocking. Direct
    // raw query avoids a DriversService → OrdersService circular dep.
    type DriverGeoRow = {
      currentLatitude: string | null;
      currentLongitude: string | null;
    };
    const profileRows: DriverGeoRow[] = await this.dataSource.query(
      `SELECT "currentLatitude", "currentLongitude"
       FROM "driver_profiles"
       WHERE "userId" = $1
       LIMIT 1`,
      [driverId],
    );
    const driverProfile: DriverGeoRow | null = profileRows[0] ?? null;

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
      const now = new Date();
      locked.driverId = driverId;
      locked.status = OrderStatus.ACCEPTED;
      locked.acceptedAt = now;

      // J4 — record matching observability inline so the row is
      // self-contained for the weekly admin metrics endpoint.
      locked.timeToFirstAcceptMs =
        now.getTime() - new Date(locked.createdAt).getTime();
      if (
        driverProfile?.currentLatitude !== null &&
        driverProfile?.currentLatitude !== undefined &&
        driverProfile.currentLongitude !== null &&
        driverProfile.currentLongitude !== undefined
      ) {
        locked.winningDriverDistanceKm = Number(
          haversineKm(
            Number(driverProfile.currentLatitude),
            Number(driverProfile.currentLongitude),
            Number(locked.pickupLatitude),
            Number(locked.pickupLongitude),
          ).toFixed(3),
        );
      }

      await manager.save(locked);
      return manager.findOne(Order, {
        where: { id: orderId },
        relations: ['customer', 'driver'],
      });
    });

    // Hold the per-order platform charge AFTER the lock releases. If this
    // fails, the order is still validly accepted; the wallet error
    // surfaces to the caller and an oncall reviewer reconciles. Inverting
    // the order (deduct first then save) would risk taking money from a
    // driver whose lock attempt loses, which is much worse. holdOrderCharge
    // re-checks the balance under its own lock — the concurrency backstop
    // for the pre-lock gate above.
    await this.walletService.holdOrderCharge(driverId, orderId, orderCharge);

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

      // Cash orders (the default model): the driver collected and KEEPS
      // all the cash. The platform's revenue is the per-order charge,
      // already held from the wallet on acceptance — nothing to credit or
      // refund here, so the charge is simply finalized (kept).
      //
      // Legacy non-cash orders (card / bank transfer): the platform holds
      // the customer's money, so credit the driver their earnings net of
      // commission as before. The accept-time charge hold still applies.
      if (order.driverId && order.paymentMethod !== PaymentMethod.CASH) {
        await this.walletService.processOrderPayment(
          order.driverId,
          order.id,
          order.finalPrice,
          order.paymentMethod,
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

  /**
   * G2 — driver confirms cash payment received on a delivered order.
   *
   * Cash-only model: the driver collected and KEEPS all the cash. The
   * platform's revenue is the per-order charge, already held from the
   * driver's prepaid wallet on acceptance. So this no longer credits the
   * wallet, splits commission, or inserts a settlement transaction — it
   * simply records that cash was collected: flip PENDING_CASH → COMPLETED
   * and stamp finalPrice (audit only).
   *
   *  - Validates the order belongs to this driver + the channel is cash +
   *    the order is delivered + payment is still pending.
   *  - Idempotent: a second call after settlement returns the order
   *    unchanged with paymentStatus already COMPLETED.
   */
  async markCashCollected(orderId: string, driverId: string): Promise<Order> {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(Order, {
        where: { id: orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) {
        throw new NotFoundException('Order not found');
      }
      if (order.driverId !== driverId) {
        throw new ForbiddenException(
          'Only the assigned driver can mark cash collected.',
        );
      }
      if (order.paymentMethod !== PaymentMethod.CASH) {
        throw new BadRequestException(
          'Cash collection only applies to cash-on-delivery orders.',
        );
      }
      if (order.status !== OrderStatus.DELIVERED) {
        throw new BadRequestException(
          'Mark the order as delivered before settling cash.',
        );
      }
      if (order.paymentStatus === OrderPaymentStatus.COMPLETED) {
        // Idempotent: replay returns the existing settled state.
        return order;
      }
      if (order.paymentStatus !== OrderPaymentStatus.PENDING_CASH) {
        throw new BadRequestException(
          `Cannot collect cash on a ${order.paymentStatus} order.`,
        );
      }

      order.paymentStatus = OrderPaymentStatus.COMPLETED;
      order.finalPrice = order.finalPrice ?? order.estimatedPrice;
      return manager.save(order);
    });
  }

  /**
   * G3 — static platform bank account read from system_config so admins
   * can update without a deploy. Returns the default placeholder when
   * the JSON is unset / unparseable.
   */
  async getPlatformBankAccount(): Promise<{
    bankName: string;
    accountName: string;
    accountNumber: string;
  }> {
    const raw = await this.configService.getString(
      ConfigKey.PLATFORM_BANK_ACCOUNT,
      '',
    );
    const fallback = {
      bankName: 'Pending — set in admin console',
      accountName: 'Orbit Technologies Ltd',
      accountNumber: '0000000000',
    };
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw) as Partial<typeof fallback>;
      return {
        bankName: parsed.bankName ?? fallback.bankName,
        accountName: parsed.accountName ?? fallback.accountName,
        accountNumber: parsed.accountNumber ?? fallback.accountNumber,
      };
    } catch {
      return fallback;
    }
  }

  /**
   * G3 — list pending-transfer orders for the admin reconcile queue.
   * Oldest-first so reviewers FIFO through deposits matching what
   * shows up in the bank statement.
   */
  async listPendingTransfers(opts: {
    limit?: number;
    offset?: number;
  }): Promise<{ items: Order[]; total: number }> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const [items, total] = await this.ordersRepository.findAndCount({
      where: { paymentStatus: OrderPaymentStatus.PENDING_TRANSFER },
      relations: ['customer'],
      order: { createdAt: 'ASC' },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }

  /**
   * G3 — admin matches a bank deposit to an order reference and
   * reconciles it. Reference is the order id (also exposed to the
   * customer as the per-order transfer reference at checkout).
   *
   * Settlement runs in one transaction:
   *   - Pessimistic_write lock on the order row.
   *   - Inserts a Transaction row tagged method=bank_transfer with
   *     reference + reviewer.
   *   - Writes an approval_decisions audit row (DR-B4).
   *   - Flips paymentStatus → COMPLETED so the order becomes
   *     broadcast-eligible in findAvailableOrders.
   *
   * Idempotent — a duplicate reconcile on a COMPLETED row returns the
   * order untouched. Throws NotFoundException for unknown references
   * and BadRequestException for non-transfer / wrong-status orders.
   */
  async reconcileBankTransfer(reference: string, admin: User): Promise<Order> {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(Order, {
        where: { id: reference },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) {
        throw new NotFoundException(
          'No order found for that reference. Double-check the reference printed on the deposit.',
        );
      }
      if (order.paymentMethod !== PaymentMethod.BANK_TRANSFER) {
        throw new BadRequestException(
          'Reconcile only applies to bank-transfer orders.',
        );
      }
      if (order.paymentStatus === OrderPaymentStatus.COMPLETED) {
        return order;
      }
      if (order.paymentStatus !== OrderPaymentStatus.PENDING_TRANSFER) {
        throw new BadRequestException(
          `Cannot reconcile a ${order.paymentStatus} order.`,
        );
      }

      // G3 reconcile records the order-level audit in approval_decisions
      // and flips order.paymentStatus to COMPLETED. We intentionally do
      // NOT insert a customer-wallet Transaction row here: bank transfer
      // funds belong to the platform, not the customer's wallet. The
      // G6 ledger invariant (sum(credits) - sum(debits) = wallet.balance)
      // depends on every Transaction row being a real wallet movement;
      // an audit-only row with balanceAfter=unchanged would silently
      // drift the invariant by `amount` on every reconcile.
      const amount = order.finalPrice ?? order.estimatedPrice;

      await manager.insert(ApprovalDecision, {
        targetType: ApprovalTargetType.ORDER,
        targetId: order.id,
        action: ApprovalAction.APPROVE,
        reviewerId: admin.id,
        reason: null,
      });

      order.paymentStatus = OrderPaymentStatus.COMPLETED;
      order.finalPrice = amount;
      return manager.save(order);
    });
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

    // Refund the held per-order charge if the order was already accepted
    // (PENDING orders never held anything). Idempotency-guarded inside the
    // wallet service so a retried cancel can't double-refund.
    if (order.driverId && order.status !== OrderStatus.PENDING) {
      await this.walletService.refundOrderCharge(
        order.driverId,
        orderId,
        order.platformCharge ?? NAIRA_ZERO,
      );
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

  /**
   * Resolve the per-delivery insurance fee from system_configs.
   *
   * Precedence: PERCENT > FIXED. If `ORDER_INSURANCE_FEE_PERCENT` is
   * a positive number, the fee is that percentage of `orderPrice`.
   * Otherwise `ORDER_INSURANCE_FEE_FIXED` is used as a flat amount.
   * Both 0 (the default) means insurance is disabled — returns null
   * so the order has no insuranceFee column set and the settlement
   * path can short-circuit.
   *
   * Negative percentages and percentages > 100 are clamped to 0 (a
   * "configuration tampering" guard, mirroring applyCommission).
   */
  private async calculateInsuranceFee(
    orderPrice: Naira,
  ): Promise<Naira | null> {
    const percent = await this.configService.getNumber(
      ConfigKey.ORDER_INSURANCE_FEE_PERCENT,
      0,
    );
    if (Number.isFinite(percent) && percent > 0 && percent <= 100) {
      return orderPrice
        .times(percent)
        .dividedBy(100)
        .toDecimalPlaces(0, Decimal.ROUND_HALF_UP) as Naira;
    }
    const fixed = await this.configService.getNumber(
      ConfigKey.ORDER_INSURANCE_FEE_FIXED,
      0,
    );
    if (Number.isFinite(fixed) && fixed > 0) {
      return naira(String(fixed));
    }
    return null;
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
