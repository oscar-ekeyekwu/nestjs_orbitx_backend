import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { Order, OrderStatus } from '../orders/entities/order.entity';
import { Transaction } from '../wallet/entities/transaction.entity';

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

// J4 — order-matching observability shape returned by
// GET /admin/metrics/order-matching. Computed over the last 7 days of
// orders that have an `acceptedAt` (i.e. the broadcast actually closed).
export interface OrderMatchingMetrics {
  windowDays: number;
  totalOrdersAccepted: number;
  averageTimeToFirstAcceptMs: number | null;
  p95TimeToFirstAcceptMs: number | null;
  averageEligibleDriversAtBroadcast: number | null;
  averageWinningDriverDistanceKm: number | null;
  // Fraction of recent orders unaccepted >2 min — the >10% threshold
  // is the spec's nudge to consider directed-offer migration.
  cherryPickRatio: number;
}

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(Transaction)
    private readonly transactionRepo: Repository<Transaction>,
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
        // Dashboard chart aggregation: Naira → number via Decimal.valueOf()
        // tolerates kobo precision for chart display. Ledger math elsewhere
        // stays in Decimal to keep kobo exactness.
        const finalPrice = order.finalPrice ? order.finalPrice.toNumber() : 0;
        revenueByDay.set(key, (revenueByDay.get(key) ?? 0) + finalPrice);
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

  async exportUsersCsv(): Promise<string> {
    const users = await this.userRepo.find({ order: { createdAt: 'DESC' } });
    return toCsv(users, [
      ['id', (u) => u.id],
      ['email', (u) => u.email],
      ['first_name', (u) => u.first_name],
      ['last_name', (u) => u.last_name],
      ['phone', (u) => u.phone],
      ['role', (u) => u.role],
      ['email_verified', (u) => u.isEmailVerified],
      ['phone_verified', (u) => u.isPhoneVerified],
      ['is_active', (u) => u.isActive],
      ['created_at', (u) => u.createdAt],
    ]);
  }

  async exportOrdersCsv(): Promise<string> {
    const orders = await this.orderRepo.find({
      order: { createdAt: 'DESC' },
    });
    return toCsv(orders, [
      ['id', (o) => o.id],
      ['customer_id', (o) => o.customerId],
      ['driver_id', (o) => o.driverId],
      ['status', (o) => o.status],
      ['package_size', (o) => o.packageSize],
      ['pickup_address', (o) => o.pickupAddress],
      ['delivery_address', (o) => o.deliveryAddress],
      ['recipient_name', (o) => o.recipientName],
      ['recipient_phone', (o) => o.recipientPhone],
      ['estimated_price', (o) => o.estimatedPrice.toFixed(2)],
      ['final_price', (o) => o.finalPrice?.toFixed(2) ?? ''],
      ['accepted_at', (o) => o.acceptedAt],
      ['picked_up_at', (o) => o.pickedUpAt],
      ['delivered_at', (o) => o.deliveredAt],
      ['created_at', (o) => o.createdAt],
    ]);
  }

  async exportTransactionsCsv(): Promise<string> {
    const txs = await this.transactionRepo.find({
      order: { createdAt: 'DESC' },
    });
    return toCsv(txs, [
      ['id', (t) => t.id],
      ['wallet_id', (t) => t.walletId],
      ['order_id', (t) => t.orderId],
      ['type', (t) => t.type],
      ['amount', (t) => t.amount.toFixed(2)],
      ['commission', (t) => t.commission.toFixed(2)],
      ['balance_after', (t) => t.balanceAfter.toFixed(2)],
      ['status', (t) => t.status],
      ['payment_method', (t) => t.paymentMethod],
      ['description', (t) => t.description],
      ['reference', (t) => t.reference],
      ['created_at', (t) => t.createdAt],
    ]);
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

  /**
   * J4 — last 7 days of order-matching metrics. Operationally this
   * answers "are drivers cherry-picking?" and "is the eligible pool
   * deep enough?" without joining a metrics warehouse.
   */
  async getOrderMatchingMetrics(): Promise<OrderMatchingMetrics> {
    const windowDays = 7;
    const since = addDays(startOfDay(new Date()), -windowDays);
    const rows = await this.orderRepo
      .createQueryBuilder('o')
      .select([
        'o."timeToFirstAcceptMs" AS "timeToFirstAcceptMs"',
        'o."eligibleDriversAtBroadcast" AS "eligibleDriversAtBroadcast"',
        'o."winningDriverDistanceKm" AS "winningDriverDistanceKm"',
        'o.createdAt AS "createdAt"',
        'o.acceptedAt AS "acceptedAt"',
      ])
      .where('o.createdAt >= :since', { since })
      .getRawMany<{
        timeToFirstAcceptMs: number | null;
        eligibleDriversAtBroadcast: number | null;
        winningDriverDistanceKm: string | null;
        createdAt: Date;
        acceptedAt: Date | null;
      }>();

    const acceptedMs = rows
      .map((r) => r.timeToFirstAcceptMs)
      .filter((v): v is number => typeof v === 'number');
    const eligible = rows
      .map((r) => r.eligibleDriversAtBroadcast)
      .filter((v): v is number => typeof v === 'number');
    const distances = rows
      .map((r) =>
        r.winningDriverDistanceKm !== null
          ? Number(r.winningDriverDistanceKm)
          : null,
      )
      .filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));

    const cherryPicked = rows.filter((r) => {
      if (!r.acceptedAt) return true;
      const elapsed =
        new Date(r.acceptedAt).getTime() - new Date(r.createdAt).getTime();
      return elapsed > 2 * 60 * 1000;
    }).length;

    const totalOrdersAccepted = rows.filter((r) => !!r.acceptedAt).length;
    return {
      windowDays,
      totalOrdersAccepted,
      averageTimeToFirstAcceptMs:
        acceptedMs.length === 0 ? null : average(acceptedMs),
      p95TimeToFirstAcceptMs:
        acceptedMs.length === 0 ? null : percentile(acceptedMs, 0.95),
      averageEligibleDriversAtBroadcast:
        eligible.length === 0 ? null : average(eligible),
      averageWinningDriverDistanceKm:
        distances.length === 0 ? null : Number(average(distances).toFixed(3)),
      cherryPickRatio:
        rows.length === 0 ? 0 : Number((cherryPicked / rows.length).toFixed(3)),
    };
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
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

type CsvColumn<T> = [header: string, getter: (row: T) => unknown];

function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const headerLine = columns.map(([h]) => csvEscape(h)).join(',');
  const dataLines = rows.map((row) =>
    columns.map(([, get]) => csvEscape(get(row))).join(','),
  );
  return [headerLine, ...dataLines].join('\n');
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let raw: string;
  if (value instanceof Date) {
    raw = value.toISOString();
  } else if (typeof value === 'string') {
    raw = value;
  } else if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    raw = String(value);
  } else {
    // Object/array fallback — JSON-stringify so the CSV cell carries
    // meaningful content rather than '[object Object]'.
    raw = JSON.stringify(value);
  }
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
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
