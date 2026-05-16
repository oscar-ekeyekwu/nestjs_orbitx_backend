import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { Order, OrderStatus } from '../orders/entities/order.entity';

export interface Trend {
  deltaPercent: number;
  direction: 'up' | 'down' | 'flat';
}

export interface DashboardStats {
  totalUsers: number;
  totalCustomers: number;
  totalDrivers: number;
  totalOrders: number;
  pendingOrders: number;
  completedOrders: number;
  totalRevenue: number;
  todayOrders: number;
  todayRevenue: number;
  trends: {
    customers: Trend;
    drivers: Trend;
    orders: Trend;
    revenue: Trend;
  };
}

export interface TimeseriesPoint {
  name: string;
  value: number;
}

export interface DashboardTimeseries {
  revenue: TimeseriesPoint[];
  orders: TimeseriesPoint[];
}

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
  ) {}

  async getDashboardStats(): Promise<DashboardStats> {
    const now = new Date();
    const startOfToday = startOfDay(now);
    const endOfToday = addDays(startOfToday, 1);
    const startOfThisWeek = addDays(startOfToday, -6);
    const startOfPrevWeek = addDays(startOfThisWeek, -7);

    const [
      totalUsers,
      totalCustomers,
      totalDrivers,
      totalOrders,
      pendingOrders,
      completedOrders,
      todayOrders,
      totalRevenue,
      todayRevenue,
      customersThisWeek,
      customersPrevWeek,
      driversThisWeek,
      driversPrevWeek,
      ordersThisWeek,
      ordersPrevWeek,
      revenueThisWeek,
      revenuePrevWeek,
    ] = await Promise.all([
      this.userRepo.count(),
      this.userRepo.count({ where: { role: UserRole.CUSTOMER } }),
      this.userRepo.count({ where: { role: UserRole.DRIVER } }),
      this.orderRepo.count(),
      this.orderRepo.count({ where: { status: OrderStatus.PENDING } }),
      this.orderRepo.count({ where: { status: OrderStatus.DELIVERED } }),
      this.countOrdersCreatedBetween(startOfToday, endOfToday),
      this.sumDeliveredRevenueBetween(),
      this.sumDeliveredRevenueBetween(startOfToday, endOfToday),
      this.countUsersByRoleCreatedBetween(
        UserRole.CUSTOMER,
        startOfThisWeek,
        endOfToday,
      ),
      this.countUsersByRoleCreatedBetween(
        UserRole.CUSTOMER,
        startOfPrevWeek,
        startOfThisWeek,
      ),
      this.countUsersByRoleCreatedBetween(
        UserRole.DRIVER,
        startOfThisWeek,
        endOfToday,
      ),
      this.countUsersByRoleCreatedBetween(
        UserRole.DRIVER,
        startOfPrevWeek,
        startOfThisWeek,
      ),
      this.countOrdersCreatedBetween(startOfThisWeek, endOfToday),
      this.countOrdersCreatedBetween(startOfPrevWeek, startOfThisWeek),
      this.sumDeliveredRevenueBetween(startOfThisWeek, endOfToday),
      this.sumDeliveredRevenueBetween(startOfPrevWeek, startOfThisWeek),
    ]);

    return {
      totalUsers,
      totalCustomers,
      totalDrivers,
      totalOrders,
      pendingOrders,
      completedOrders,
      totalRevenue,
      todayOrders,
      todayRevenue,
      trends: {
        customers: trend(customersThisWeek, customersPrevWeek),
        drivers: trend(driversThisWeek, driversPrevWeek),
        orders: trend(ordersThisWeek, ordersPrevWeek),
        revenue: trend(revenueThisWeek, revenuePrevWeek),
      },
    };
  }

  async getTimeseries(): Promise<DashboardTimeseries> {
    const startOfToday = startOfDay(new Date());
    const start = addDays(startOfToday, -6);
    const end = addDays(startOfToday, 1);

    const [createdOrders, deliveredOrders] = await Promise.all([
      this.orderRepo
        .createQueryBuilder('o')
        .select(['o.id', 'o.createdAt'])
        .where('o.createdAt >= :start', { start })
        .andWhere('o.createdAt < :end', { end })
        .getMany(),
      this.orderRepo
        .createQueryBuilder('o')
        .select(['o.id', 'o.finalPrice', 'o.deliveredAt'])
        .where('o.status = :status', { status: OrderStatus.DELIVERED })
        .andWhere('o.deliveredAt >= :start', { start })
        .andWhere('o.deliveredAt < :end', { end })
        .getMany(),
    ]);

    const days: { key: string; name: string }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      days.push({
        key: d.toDateString(),
        name: d.toLocaleDateString('en-US', { weekday: 'short' }),
      });
    }

    const ordersByDay = new Map<string, number>(days.map((d) => [d.key, 0]));
    const revenueByDay = new Map<string, number>(days.map((d) => [d.key, 0]));

    for (const order of createdOrders) {
      const key = startOfDay(order.createdAt).toDateString();
      if (ordersByDay.has(key)) {
        ordersByDay.set(key, (ordersByDay.get(key) ?? 0) + 1);
      }
    }
    for (const order of deliveredOrders) {
      if (!order.deliveredAt) continue;
      const key = startOfDay(order.deliveredAt).toDateString();
      if (revenueByDay.has(key)) {
        revenueByDay.set(
          key,
          (revenueByDay.get(key) ?? 0) + Number(order.finalPrice ?? 0),
        );
      }
    }

    return {
      orders: days.map((d) => ({
        name: d.name,
        value: ordersByDay.get(d.key) ?? 0,
      })),
      revenue: days.map((d) => ({
        name: d.name,
        value: revenueByDay.get(d.key) ?? 0,
      })),
    };
  }

  private async countOrdersCreatedBetween(
    start: Date,
    end: Date,
  ): Promise<number> {
    return this.orderRepo
      .createQueryBuilder('o')
      .where('o.createdAt >= :start', { start })
      .andWhere('o.createdAt < :end', { end })
      .getCount();
  }

  private async countUsersByRoleCreatedBetween(
    role: UserRole,
    start: Date,
    end: Date,
  ): Promise<number> {
    return this.userRepo
      .createQueryBuilder('u')
      .where('u.role = :role', { role })
      .andWhere('u.createdAt >= :start', { start })
      .andWhere('u.createdAt < :end', { end })
      .getCount();
  }

  private async sumDeliveredRevenueBetween(
    start?: Date,
    end?: Date,
  ): Promise<number> {
    const qb = this.orderRepo
      .createQueryBuilder('o')
      .select('COALESCE(SUM(o.finalPrice), 0)', 'total')
      .where('o.status = :status', { status: OrderStatus.DELIVERED });
    if (start) qb.andWhere('o.deliveredAt >= :start', { start });
    if (end) qb.andWhere('o.deliveredAt < :end', { end });
    const row = await qb.getRawOne<{ total: string }>();
    return Number(row?.total ?? 0);
  }
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function trend(current: number, previous: number): Trend {
  if (previous === 0) {
    if (current === 0) return { deltaPercent: 0, direction: 'flat' };
    return { deltaPercent: 100, direction: 'up' };
  }
  const delta = ((current - previous) / previous) * 100;
  const rounded = Math.round(delta * 10) / 10;
  if (Math.abs(rounded) < 0.05) return { deltaPercent: 0, direction: 'flat' };
  return {
    deltaPercent: Math.abs(rounded),
    direction: rounded > 0 ? 'up' : 'down',
  };
}
