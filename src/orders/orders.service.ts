import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderStatus, PackageSize } from './entities/order.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UserRole } from '../common/enums/user-role.enum';
import { WalletService } from '../wallet/wallet.service';
import { SystemConfigService } from '../config/config.service';
import { ConfigKey } from '../config/enums/config-keys.enum';
import { PaymentMethod } from '../wallet/entities/transaction.entity';
import {
  PaginationDto,
  PaginatedResult,
  createPaginatedResponse,
} from '../common/dto/pagination.dto';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    private walletService: WalletService,
    private configService: SystemConfigService,
  ) {}

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

    return this.ordersRepository.save(order);
  }

  async findAll(
    userId: string,
    userRole: UserRole,
    paginationDto: PaginationDto,
    status?: OrderStatus,
  ): Promise<PaginatedResult<Order>> {
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
      .skip(paginationDto.skip)
      .take(paginationDto.limit);

    const [orders, total] = await query.getManyAndCount();

    return createPaginatedResponse(
      orders,
      total,
      paginationDto.page!,
      paginationDto.limit!,
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

  async acceptOrder(orderId: string, driverId: string): Promise<Order> {
    const order = await this.findOne(orderId);

    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Order is not available');
    }

    // Check if driver meets minimum balance requirement
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

    order.driverId = driverId;
    order.status = OrderStatus.ACCEPTED;
    order.acceptedAt = new Date();

    return this.ordersRepository.save(order);
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

      // Process payment to driver's wallet (cash payment by default)
      if (order.driverId) {
        await this.walletService.processOrderPayment(
          order.driverId,
          order.id,
          Number(order.finalPrice),
          PaymentMethod.CASH,
        );
      }
    }

    return this.ordersRepository.save(order);
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

    order.status = OrderStatus.CANCELLED;
    return this.ordersRepository.save(order);
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
  ): Promise<number> {
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

    const distancePrice = distance * pricePerKm;
    const totalPrice =
      (basePrice + distancePrice) * sizeMultiplier[packageSize];

    return Math.round(totalPrice);
  }

  private calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371; // Earth's radius in km
    const dLat = this.deg2rad(lat2 - lat1);
    const dLon = this.deg2rad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.deg2rad(lat1)) *
        Math.cos(this.deg2rad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private deg2rad(deg: number): number {
    return deg * (Math.PI / 180);
  }
}
