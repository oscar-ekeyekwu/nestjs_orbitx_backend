import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CreateOrderRequestDto } from './dto/create-order-request.dto';
import { SubmitOfferDto } from './dto/submit-offer.dto';
import {
  OrderRequest,
  OrderRequestStatus,
} from './entities/order-request.entity';
import {
  DispatchOffer,
  DispatchOfferStatus,
  DispatchOfferType,
} from './entities/dispatch-offer.entity';
import {
  Order,
  OrderPaymentStatus,
  OrderStatus,
} from '../orders/entities/order.entity';
import { OrdersService } from '../orders/orders.service';
import { WalletService } from '../wallet/wallet.service';
import { SystemConfigService } from '../config/config.service';
import { ConfigKey } from '../config/enums/config-keys.enum';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { UserRole } from '../common/enums/user-role.enum';
import { PaymentMethod } from '../wallet/enums/payment-method.enum';
import { assertInsideLagos, assertInsideNigeria, haversineKm } from '../common/geo';
import { Naira, naira } from '../common/money';
import Decimal from 'decimal.js';

/**
 * Phase 2 dispatch — replaces direct order creation with a request
 * + offer loop.
 *
 *   1. Customer POSTs an OrderRequest                      (create)
 *   2. Drivers in the eligible room receive request_created
 *   3. Each driver POSTs an offer (quote_accept | counter) (submitOffer)
 *      - quote_accept auto-resolves the request (and creates an
 *        Order with status=ACCEPTED, paymentStatus=PENDING_TRANSFER)
 *      - counter goes into the customer's queue
 *   4. Customer POSTs accept on a counter offer            (acceptOffer)
 *   5. Losing offers are flipped to REJECTED + sockets emit
 *      offer_update so drivers' UIs drop the request from their list
 *
 * The transactional resolve step uses pessimistic locks on both the
 * request and the offer so the auto-accept + customer-pick paths
 * cannot double-resolve a request.
 */
@Injectable()
export class OrderRequestsService {
  private readonly logger = new Logger(OrderRequestsService.name);

  // Lower/upper bounds for counter offers — guards driver abuse in
  // both directions. Tunable later; hardcoded for v1.
  private static readonly COUNTER_MIN_MULTIPLIER = 0.8;
  private static readonly COUNTER_MAX_MULTIPLIER = 2.0;

  constructor(
    @InjectRepository(OrderRequest)
    private readonly requestsRepo: Repository<OrderRequest>,
    @InjectRepository(DispatchOffer)
    private readonly offersRepo: Repository<DispatchOffer>,
    @InjectRepository(Order)
    private readonly ordersRepo: Repository<Order>,
    @Inject(forwardRef(() => OrdersService))
    private readonly ordersService: OrdersService,
    private readonly walletService: WalletService,
    private readonly configService: SystemConfigService,
    @Inject(forwardRef(() => RealtimeGateway))
    private readonly realtimeGateway: RealtimeGateway,
    private readonly eventEmitter: EventEmitter2,
    private readonly dataSource: DataSource,
  ) {}

  // -------- Customer creates a request ------------------------------

  async create(
    dto: CreateOrderRequestDto,
    customerId: string,
  ): Promise<OrderRequest> {
    // Geo sanity — same gates as Order.create() so request and order
    // can never disagree about service-area boundaries.
    assertInsideNigeria(dto.pickupLatitude, dto.pickupLongitude);
    assertInsideNigeria(dto.deliveryLatitude, dto.deliveryLongitude);
    await assertInsideLagos(
      dto.pickupLatitude,
      dto.pickupLongitude,
      this.configService,
    );
    await assertInsideLagos(
      dto.deliveryLatitude,
      dto.deliveryLongitude,
      this.configService,
    );

    // Same quote logic as the legacy Order.create() path so the
    // customer's preview, the driver's quote_accept value, and the
    // eventual Order all agree to the kobo.
    const quote = await this.ordersService.quote({
      pickupLatitude: dto.pickupLatitude,
      pickupLongitude: dto.pickupLongitude,
      deliveryLatitude: dto.deliveryLatitude,
      deliveryLongitude: dto.deliveryLongitude,
      packageSize: dto.packageSize,
    });

    const ttlSeconds = await this.configService.getNumber(
      ConfigKey.ORDER_REQUEST_TTL_SECONDS,
      300,
    );

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    // J4-style observability — sample the eligible-pool size at
    // broadcast. Failures don't block the create.
    let eligibleAtBroadcast: number | null = null;
    try {
      eligibleAtBroadcast = await this.realtimeGateway.countEligibleDrivers(
        dto.packageSize,
      );
    } catch {
      eligibleAtBroadcast = null;
    }

    const request = this.requestsRepo.create({
      customerId,
      status: OrderRequestStatus.OPEN,
      pickupLatitude: dto.pickupLatitude,
      pickupLongitude: dto.pickupLongitude,
      pickupAddress: dto.pickupAddress,
      deliveryLatitude: dto.deliveryLatitude,
      deliveryLongitude: dto.deliveryLongitude,
      deliveryAddress: dto.deliveryAddress,
      recipientName: dto.recipientName,
      recipientPhone: dto.recipientPhone,
      packageDescription: dto.packageDescription,
      packageWeight: dto.packageWeight ?? null,
      packageSize: dto.packageSize,
      deliveryNotes: dto.deliveryNotes ?? null,
      quotedPrice: quote.estimatedPrice,
      insuranceFee: quote.insuranceFee,
      platformCharge: quote.platformCharge,
      distanceKm: quote.distanceKm,
      expiresAt,
      eligibleDriversAtBroadcast: eligibleAtBroadcast,
    });

    const saved = await this.requestsRepo.save(request);

    this.logger.log(
      `OrderRequest created id=${saved.id} customer=${customerId} ` +
        `packageSize=${saved.packageSize} quote=${quote.estimatedPrice.toString()} ` +
        `eligibleAtBroadcast=${eligibleAtBroadcast ?? 'n/a'}`,
    );

    // Socket fanout + push event. Both fire-and-forget; failures
    // never bubble back to the customer.
    try {
      this.realtimeGateway.emitRequestCreated(saved.packageSize, {
        id: saved.id,
        pickupAddress: saved.pickupAddress,
        pickupLatitude: saved.pickupLatitude,
        pickupLongitude: saved.pickupLongitude,
        deliveryAddress: saved.deliveryAddress,
        packageSize: saved.packageSize,
        quotedPrice: saved.quotedPrice.toString(),
        distanceKm: saved.distanceKm,
        expiresAt: saved.expiresAt.toISOString(),
      });
    } catch (err) {
      this.logger.error(`request_created emit failed: ${String(err)}`);
    }

    // Reused push fanout — the existing order.created subscriber
    // already filters by isOnline/active/onDelivery/radius/wallet,
    // which matches our request eligibility. The payload shape is
    // intentionally compatible (orderId carries the requestId; the
    // push title/body comes from the subscriber's existing templates).
    // A future refactor can split this into a dedicated event; the
    // shared subscriber is the smallest immediate win.
    this.eventEmitter.emit('order.created', {
      orderId: saved.id,
      packageSize: saved.packageSize,
      pickupAddress: saved.pickupAddress,
      deliveryAddress: saved.deliveryAddress,
      estimatedPriceNaira: Number(saved.quotedPrice),
      pickupLatitude: saved.pickupLatitude,
      pickupLongitude: saved.pickupLongitude,
      platformChargeNaira: Number(saved.platformCharge ?? 0),
      // Phase 2 dispatch — discriminates the request flow from a
      // direct order create so the push subscriber can swap the
      // title ("New delivery request" vs "New delivery available")
      // and the data.kind ("order_request.created" vs
      // "order.created"). Mobile reads data.kind to deep-link.
      source: 'order_request',
    });

    return saved;
  }

  // -------- Driver submits an offer ---------------------------------

  async submitOffer(
    requestId: string,
    driverId: string,
    dto: SubmitOfferDto,
  ): Promise<{ offer: DispatchOffer; resolvedOrderId: string | null }> {
    const offerTtlSec = await this.configService.getNumber(
      ConfigKey.DISPATCH_OFFER_TTL_SECONDS,
      60,
    );

    const txnResult = await this.dataSource.transaction(async (manager) => {
      // Pessimistic lock on the request so two concurrent quote_accept
      // submissions can't both win.
      const request = await manager.findOne(OrderRequest, {
        where: { id: requestId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request) {
        throw new NotFoundException('OrderRequest not found');
      }
      if (request.status !== OrderRequestStatus.OPEN) {
        throw new BadRequestException(
          `Request is ${request.status} and no longer accepting offers.`,
        );
      }
      if (request.expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException('Request has expired.');
      }

      // Single-active-offer guard. The partial unique index also
      // enforces this at the DB layer; we check here for a friendly
      // error message.
      const activeOffer = await manager.findOne(DispatchOffer, {
        where: { driverId, status: DispatchOfferStatus.PENDING },
      });
      if (activeOffer && activeOffer.requestId !== requestId) {
        throw new BadRequestException(
          'You already have a pending offer on another request. Withdraw it before submitting a new one.',
        );
      }
      if (activeOffer && activeOffer.requestId === requestId) {
        throw new BadRequestException(
          'You already have a pending offer on this request.',
        );
      }

      // Resolve the offer price. For quote_accept it MUST match the
      // request's quotedPrice exactly (server copies; we don't trust
      // the client). For counter, the DTO provides it and we clamp
      // against COUNTER_MIN/MAX bounds.
      let price: Naira;
      if (dto.type === DispatchOfferType.QUOTE_ACCEPT) {
        price = request.quotedPrice;
      } else {
        if (dto.price == null) {
          throw new BadRequestException(
            'Counter offers must include a price.',
          );
        }
        const min = request.quotedPrice
          .times(OrderRequestsService.COUNTER_MIN_MULTIPLIER)
          .toDecimalPlaces(0, Decimal.ROUND_HALF_UP) as Naira;
        const max = request.quotedPrice
          .times(OrderRequestsService.COUNTER_MAX_MULTIPLIER)
          .toDecimalPlaces(0, Decimal.ROUND_HALF_UP) as Naira;
        const proposed = naira(String(Math.round(dto.price)));
        if (proposed.lessThan(min) || proposed.greaterThan(max)) {
          throw new BadRequestException(
            `Counter price must be between ₦${min.toString()} and ₦${max.toString()}.`,
          );
        }
        price = proposed;
      }

      // Wallet check — the driver must be able to cover the platform
      // charge + insurance fee (per the user's spec). Insurance is
      // recomputed at offer time from the request snapshot so a config
      // change between request and offer doesn't surprise the driver.
      const platformCharge = request.platformCharge ?? (naira('0') as Naira);
      const insurance = request.insuranceFee ?? (naira('0') as Naira);
      const required = platformCharge.plus(insurance) as Naira;
      const canCover = await this.walletService.canDriverCoverCharge(
        driverId,
        required,
      );
      if (!canCover) {
        throw new BadRequestException(
          `Insufficient wallet balance for this delivery. You need at least ₦${required.toString()} (platform charge + insurance).`,
        );
      }

      const offer = manager.create(DispatchOffer, {
        requestId,
        driverId,
        type: dto.type,
        status: DispatchOfferStatus.PENDING,
        price,
        etaSeconds: dto.etaSeconds,
        reason: dto.reason ?? null,
        offerExpiresAt: new Date(Date.now() + offerTtlSec * 1000),
      });
      const savedOffer = await manager.save(offer);

      this.logger.log(
        `Offer submitted id=${savedOffer.id} request=${requestId} ` +
          `driver=${driverId} type=${dto.type} price=${price.toString()}`,
      );

      // Notify the customer immediately so the "Finding driver" list
      // updates. Outside the txn would be cleaner, but the lock window
      // is tiny and we want the customer to see the offer the moment
      // it commits.
      try {
        this.realtimeGateway.emitOfferUpdate(request.customerId, {
          requestId,
          offerId: savedOffer.id,
          kind: 'submitted',
          offer: {
            id: savedOffer.id,
            driverId,
            type: savedOffer.type,
            price: savedOffer.price.toString(),
            etaSeconds: savedOffer.etaSeconds,
            reason: savedOffer.reason,
            offerExpiresAt: savedOffer.offerExpiresAt.toISOString(),
          },
        });
      } catch (err) {
        this.logger.error(`offer_update emit failed: ${String(err)}`);
      }

      // Auto-accept on quote_accept — resolve the request now and
      // create the Order. The lock we already hold ensures only ONE
      // quote_accept can take this code path per request.
      if (dto.type === DispatchOfferType.QUOTE_ACCEPT) {
        const order = await this.resolveRequestInTxn(
          manager,
          request,
          savedOffer,
        );
        return {
          offer: savedOffer,
          resolvedOrderId: order.id,
          driverId: savedOffer.driverId,
          chargeAmount: request.platformCharge,
        };
      }

      return {
        offer: savedOffer,
        resolvedOrderId: null as string | null,
        driverId: null as string | null,
        chargeAmount: null as Naira | null,
      };
    });

    // Wallet hold runs OUTSIDE the txn — match the existing
    // OrdersService.acceptOrder pattern. holdOrderCharge opens its
    // own transaction; calling it inside a parent txn would deadlock.
    // Failure here leaves a created Order without a hold (same race
    // window as the legacy accept flow); we log loudly so an oncall
    // reviewer can reconcile.
    if (txnResult.resolvedOrderId && txnResult.driverId && txnResult.chargeAmount) {
      await this.holdChargeAfterCommit(
        txnResult.driverId,
        txnResult.resolvedOrderId,
        txnResult.chargeAmount,
      );
    }

    return {
      offer: txnResult.offer,
      resolvedOrderId: txnResult.resolvedOrderId,
    };
  }

  private async holdChargeAfterCommit(
    driverId: string,
    orderId: string,
    amount: Naira,
  ): Promise<void> {
    try {
      await this.walletService.holdOrderCharge(driverId, orderId, amount);
    } catch (err) {
      this.logger.error(
        `CRITICAL — holdOrderCharge failed AFTER Order ${orderId} ` +
          `was created via request flow. driver=${driverId} ` +
          `amount=${amount.toString()}. Reconcile manually. Cause: ${String(err)}`,
      );
    }
  }

  // -------- Customer accepts a counter offer ------------------------

  async acceptOffer(
    requestId: string,
    offerId: string,
    customerId: string,
  ): Promise<{ orderId: string }> {
    const txnResult = await this.dataSource.transaction(async (manager) => {
      const request = await manager.findOne(OrderRequest, {
        where: { id: requestId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request) {
        throw new NotFoundException('OrderRequest not found');
      }
      if (request.customerId !== customerId) {
        throw new ForbiddenException(
          'You cannot accept offers on someone else’s request.',
        );
      }
      if (request.status !== OrderRequestStatus.OPEN) {
        throw new BadRequestException(
          `Request is ${request.status} and can no longer be resolved.`,
        );
      }

      const offer = await manager.findOne(DispatchOffer, {
        where: { id: offerId, requestId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!offer) {
        throw new NotFoundException('Offer not found on this request.');
      }
      if (offer.status !== DispatchOfferStatus.PENDING) {
        throw new BadRequestException(
          `Offer is ${offer.status} and cannot be accepted.`,
        );
      }
      if (offer.offerExpiresAt.getTime() <= Date.now()) {
        throw new BadRequestException('Offer has expired.');
      }

      const order = await this.resolveRequestInTxn(manager, request, offer);
      return {
        orderId: order.id,
        driverId: offer.driverId,
        chargeAmount: request.platformCharge,
      };
    });

    if (txnResult.chargeAmount) {
      await this.holdChargeAfterCommit(
        txnResult.driverId,
        txnResult.orderId,
        txnResult.chargeAmount,
      );
    }

    return { orderId: txnResult.orderId };
  }

  /**
   * Shared resolve path — used by both auto-accept (quote_accept)
   * and customer-pick (counter). Caller holds the pessimistic locks
   * on request + offer; we create the Order, hold the driver's
   * platform charge, flip terminal states, and fire sockets.
   */
  private async resolveRequestInTxn(
    manager: import('typeorm').EntityManager,
    request: OrderRequest,
    winningOffer: DispatchOffer,
  ): Promise<Order> {
    // Create the Order. paymentMethod = bank_transfer (offline pay
    // confirmed by customer + driver) per the user's spec — no
    // gateway integration.
    const order = manager.create(Order, {
      customerId: request.customerId,
      driverId: winningOffer.driverId,
      status: OrderStatus.ACCEPTED,
      pickupLatitude: request.pickupLatitude,
      pickupLongitude: request.pickupLongitude,
      pickupAddress: request.pickupAddress,
      deliveryLatitude: request.deliveryLatitude,
      deliveryLongitude: request.deliveryLongitude,
      deliveryAddress: request.deliveryAddress,
      recipientName: request.recipientName,
      recipientPhone: request.recipientPhone,
      packageDescription: request.packageDescription,
      packageWeight: request.packageWeight ?? undefined,
      packageSize: request.packageSize,
      deliveryNotes: request.deliveryNotes ?? undefined,
      estimatedPrice: request.quotedPrice,
      finalPrice: winningOffer.price,
      insuranceFee: request.insuranceFee,
      platformCharge: request.platformCharge,
      paymentMethod: PaymentMethod.BANK_TRANSFER,
      paymentStatus: OrderPaymentStatus.PENDING_TRANSFER,
      acceptedAt: new Date(),
      orderRequestId: request.id,
    });
    const savedOrder = await manager.save(order);

    // Wallet hold is intentionally deferred to AFTER this txn commits
    // — matches OrdersService.acceptOrder, which calls
    // walletService.holdOrderCharge outside its own pessimistic-lock
    // transaction (holdOrderCharge opens its own queryRunner internally
    // so nesting deadlocks). Callers (submitOffer / acceptOffer) take
    // care of the hold call once the resolve commits.

    // Flip terminal states. Other offers on the request become
    // REJECTED (the customer effectively rejected them by picking
    // this one) so the partial unique index frees those drivers up
    // for future requests.
    winningOffer.status = DispatchOfferStatus.ACCEPTED;
    await manager.save(winningOffer);

    await manager
      .createQueryBuilder()
      .update(DispatchOffer)
      .set({ status: DispatchOfferStatus.REJECTED })
      .where('requestId = :requestId', { requestId: request.id })
      .andWhere('id != :winningId', { winningId: winningOffer.id })
      .andWhere('status = :pending', { pending: DispatchOfferStatus.PENDING })
      .execute();

    request.status = OrderRequestStatus.RESOLVED;
    request.resolvedOrderId = savedOrder.id;
    request.resolvedOfferId = winningOffer.id;
    await manager.save(request);

    this.logger.log(
      `OrderRequest resolved id=${request.id} → order=${savedOrder.id} ` +
        `driver=${winningOffer.driverId} price=${winningOffer.price.toString()}`,
    );

    try {
      this.realtimeGateway.emitRequestResolved({
        packageSize: request.packageSize,
        requestId: request.id,
        customerId: request.customerId,
        outcome: 'resolved',
        orderId: savedOrder.id,
        winningDriverId: winningOffer.driverId,
      });
    } catch (err) {
      this.logger.error(`request_resolved emit failed: ${String(err)}`);
    }

    return savedOrder;
  }

  // -------- Customer cancels --------------------------------------

  async cancel(requestId: string, customerId: string): Promise<OrderRequest> {
    return this.dataSource.transaction(async (manager) => {
      const request = await manager.findOne(OrderRequest, {
        where: { id: requestId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request) {
        throw new NotFoundException('OrderRequest not found');
      }
      if (request.customerId !== customerId) {
        throw new ForbiddenException(
          'You cannot cancel someone else’s request.',
        );
      }
      if (request.status !== OrderRequestStatus.OPEN) {
        throw new BadRequestException(
          `Request is already ${request.status}; nothing to cancel.`,
        );
      }

      request.status = OrderRequestStatus.CANCELLED;
      await manager.save(request);

      await manager
        .createQueryBuilder()
        .update(DispatchOffer)
        .set({ status: DispatchOfferStatus.WITHDRAWN })
        .where('requestId = :requestId', { requestId })
        .andWhere('status = :pending', { pending: DispatchOfferStatus.PENDING })
        .execute();

      this.realtimeGateway.emitRequestResolved({
        packageSize: request.packageSize,
        requestId: request.id,
        customerId: request.customerId,
        outcome: 'cancelled',
      });

      this.logger.log(`OrderRequest cancelled id=${requestId}`);
      return request;
    });
  }

  // -------- Reads ---------------------------------------------------

  async findOneScoped(
    requestId: string,
    userId: string,
    role: UserRole,
  ): Promise<OrderRequest> {
    const request = await this.requestsRepo.findOne({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException('OrderRequest not found');
    }
    if (role !== UserRole.ADMIN && request.customerId !== userId) {
      // Drivers who submitted an offer can read the request too.
      if (role === UserRole.DRIVER) {
        const ownOffer = await this.offersRepo.findOne({
          where: { requestId, driverId: userId },
        });
        if (!ownOffer) {
          throw new ForbiddenException('Not your request.');
        }
      } else {
        throw new ForbiddenException('Not your request.');
      }
    }
    return request;
  }

  async findOffers(
    requestId: string,
    userId: string,
    role: UserRole,
  ): Promise<DispatchOffer[]> {
    const request = await this.findOneScoped(requestId, userId, role);
    return this.offersRepo.find({
      where: { requestId: request.id },
      order: { createdAt: 'ASC' },
    });
  }

  // -------- Driver-side available list -----------------------------

  /**
   * Returns the open OrderRequests this driver is eligible to act on
   * — used by the driver mobile to browse requests if they missed
   * the live socket push. Mirrors the eligibility checks the
   * push-fanout subscriber applies at request-creation time:
   *
   *   - status = open
   *   - driver isOnline + verificationStatus = active + !isOnDelivery
   *   - within ORDER_REQUEST_RADIUS_KM of pickup
   *   - wallet.balance >= platformCharge + insuranceFee
   *   - driver has no other pending offer (single-active-offer rule)
   *
   * Returns the requests with the driver's current
   * distanceFromDriverKm pre-computed so the mobile list can sort
   * by proximity without re-deriving it.
   */
  async findAvailableForDriver(driverId: string): Promise<
    Array<
      OrderRequest & {
        distanceFromDriverKm: number;
      }
    >
  > {
    // Driver gate — must be online + active + idle, and have a
    // current location so we can compute the radius filter.
    const profileRows = (await this.requestsRepo.query(
      `SELECT "isOnline", "verificationStatus", "isOnDelivery",
              "currentLatitude", "currentLongitude"
       FROM driver_profiles
       WHERE "userId" = $1
       LIMIT 1`,
      [driverId],
    )) as Array<{
      isOnline: boolean;
      verificationStatus: string;
      isOnDelivery: boolean;
      currentLatitude: string | null;
      currentLongitude: string | null;
    }>;
    const profile = profileRows[0];
    if (!profile) return [];
    if (
      !profile.isOnline ||
      profile.verificationStatus !== 'active' ||
      profile.isOnDelivery ||
      profile.currentLatitude == null ||
      profile.currentLongitude == null
    ) {
      return [];
    }

    // Single-active-offer guard — if the driver already has one
    // pending offer, they can't pick a second so return nothing.
    const activeOffer = await this.offersRepo.findOne({
      where: { driverId, status: DispatchOfferStatus.PENDING },
    });
    if (activeOffer) return [];

    const radiusKm = await this.configService.getNumber(
      ConfigKey.ORDER_REQUEST_RADIUS_KM,
      5,
    );

    // Driver wallet balance for the wallet-coverage filter.
    const walletRows = (await this.requestsRepo.query(
      `SELECT balance FROM wallets WHERE "userId" = $1 LIMIT 1`,
      [driverId],
    )) as Array<{ balance: string }>;
    const walletBalance = walletRows[0]
      ? Number(walletRows[0].balance)
      : 0;

    const open = await this.requestsRepo.find({
      where: { status: OrderRequestStatus.OPEN },
      order: { createdAt: 'DESC' },
    });

    const driverLat = Number(profile.currentLatitude);
    const driverLng = Number(profile.currentLongitude);

    const eligible: Array<
      OrderRequest & { distanceFromDriverKm: number }
    > = [];
    for (const r of open) {
      // Skip expired (cron will sweep but a fast read can still see
      // them).
      if (r.expiresAt.getTime() <= Date.now()) continue;
      // Wallet coverage gate: platformCharge + insuranceFee.
      const required =
        Number(r.platformCharge ?? 0) + Number(r.insuranceFee ?? 0);
      if (walletBalance < required) continue;
      const distanceFromDriverKm = haversineKm(
        driverLat,
        driverLng,
        r.pickupLatitude,
        r.pickupLongitude,
      );
      if (distanceFromDriverKm > radiusKm) continue;
      eligible.push({ ...r, distanceFromDriverKm });
    }
    eligible.sort(
      (a, b) => a.distanceFromDriverKm - b.distanceFromDriverKm,
    );
    return eligible;
  }

  // -------- Customer list ------------------------------------------

  /**
   * Returns the customer's currently-OPEN requests, freshest first.
   * The customer mobile calls this on home-screen mount; if the
   * result is non-empty it surfaces a "Resume searching" card so a
   * killed-then-relaunched app doesn't strand the in-flight flow.
   *
   * Expired/cancelled/resolved requests are filtered out — there's
   * nothing to resume on those.
   */
  async findOwnOpen(customerId: string): Promise<OrderRequest[]> {
    return this.requestsRepo.find({
      where: {
        customerId,
        status: OrderRequestStatus.OPEN,
      },
      order: { createdAt: 'DESC' },
    });
  }

  // -------- Admin list ---------------------------------------------

  /**
   * Admin Live-Requests view. Returns a snapshot of every currently-
   * OPEN request along with its pending-offer count and the customer
   * name for the dispatcher table. Polled by the admin UI; cheap
   * enough to run every 10s without indexes beyond what the migration
   * already creates.
   */
  async findOpenForAdmin(): Promise<
    Array<{
      id: string;
      customerId: string;
      customerName: string | null;
      pickupAddress: string;
      deliveryAddress: string;
      packageSize: string;
      quotedPrice: string;
      distanceKm: number | null;
      pendingOfferCount: number;
      expiresAt: string;
      createdAt: string;
    }>
  > {
    type Row = {
      id: string;
      customerId: string;
      customerName: string | null;
      pickupAddress: string;
      deliveryAddress: string;
      packageSize: string;
      quotedPrice: string;
      distanceKm: string | null;
      pendingOfferCount: string;
      expiresAt: Date;
      createdAt: Date;
    };

    const rows = await this.requestsRepo.query(`
      SELECT
        r.id                                 AS "id",
        r."customerId"                       AS "customerId",
        TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS "customerName",
        r."pickupAddress"                    AS "pickupAddress",
        r."deliveryAddress"                  AS "deliveryAddress",
        r."packageSize"                      AS "packageSize",
        r."quotedPrice"                      AS "quotedPrice",
        r."distanceKm"                       AS "distanceKm",
        COALESCE(o.pending_count, 0)         AS "pendingOfferCount",
        r."expiresAt"                        AS "expiresAt",
        r."createdAt"                        AS "createdAt"
      FROM order_requests r
      LEFT JOIN users u ON u.id = r."customerId"
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS pending_count
        FROM dispatch_offers d
        WHERE d."requestId" = r.id
          AND d."status" = 'pending'
      ) o ON true
      WHERE r."status" = 'open'
      ORDER BY r."createdAt" DESC
    `);

    return (rows as unknown as Row[]).map((r) => ({
      id: r.id,
      customerId: r.customerId,
      customerName: r.customerName?.trim() || null,
      pickupAddress: r.pickupAddress,
      deliveryAddress: r.deliveryAddress,
      packageSize: r.packageSize,
      quotedPrice: r.quotedPrice,
      distanceKm: r.distanceKm == null ? null : Number(r.distanceKm),
      pendingOfferCount: Number(r.pendingOfferCount),
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // -------- Expiry sweeper (called by cron) -----------------------

  async sweepExpired(): Promise<{ requests: number; offers: number }> {
    const now = new Date();

    // Expire individual offers whose 60s TTL has elapsed but whose
    // parent request is still open. Customer's UI will see these
    // drop off via offer_update on next reload (lightweight; we
    // intentionally don't emit per expiry).
    const offerResult = await this.offersRepo
      .createQueryBuilder()
      .update(DispatchOffer)
      .set({ status: DispatchOfferStatus.EXPIRED })
      .where('status = :pending', { pending: DispatchOfferStatus.PENDING })
      .andWhere('offerExpiresAt <= :now', { now })
      .execute();

    // Expire requests whose 5min TTL has elapsed and cascade their
    // pending offers to EXPIRED so the partial unique index frees
    // up affected drivers.
    const expiredRequests = await this.requestsRepo.find({
      where: { status: OrderRequestStatus.OPEN },
    });
    let requestCount = 0;
    for (const r of expiredRequests) {
      if (r.expiresAt.getTime() > now.getTime()) continue;
      r.status = OrderRequestStatus.EXPIRED;
      await this.requestsRepo.save(r);
      await this.offersRepo
        .createQueryBuilder()
        .update(DispatchOffer)
        .set({ status: DispatchOfferStatus.EXPIRED })
        .where('requestId = :requestId', { requestId: r.id })
        .andWhere('status = :pending', {
          pending: DispatchOfferStatus.PENDING,
        })
        .execute();
      try {
        this.realtimeGateway.emitRequestResolved({
          packageSize: r.packageSize,
          requestId: r.id,
          customerId: r.customerId,
          outcome: 'expired',
        });
      } catch {
        // Best-effort emit.
      }
      requestCount++;
    }

    if (requestCount > 0 || (offerResult.affected ?? 0) > 0) {
      this.logger.log(
        `Expiry sweep — requests=${requestCount} offers=${offerResult.affected ?? 0}`,
      );
    }
    return { requests: requestCount, offers: offerResult.affected ?? 0 };
  }
}
