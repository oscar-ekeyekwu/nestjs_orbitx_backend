import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, IsNull } from 'typeorm';
import { Order, OrderStatus } from './entities/order.entity';
import { SystemConfigService } from '../config/config.service';
import { ConfigKey } from '../config/enums/config-keys.enum';

/**
 * Stale-pending cleanup. Without it, every test order ever created
 * lingers in PENDING forever — the driver's available-orders list
 * grows unbounded and operators can't tell live orders apart from
 * abandoned ones. The cron flips orders to CANCELLED once their
 * age exceeds ORDER_AUTO_CANCEL_MINUTES (default 60). The
 * available-orders endpoint also age-filters at read time, so this
 * cron is the slower-but-permanent cleanup.
 *
 * Conservative scope:
 *   - Only orders in PENDING get touched. Accepted/picked_up/etc.
 *     stay.
 *   - Only orders with no driverId (no one accepted) — defensive
 *     belt-and-braces.
 *   - No wallet refunds, no notifications — nothing to refund or
 *     notify on a PENDING order, and the operator can see the
 *     cancellation count in the log to audit. If the order grew a
 *     real accept later, the driverId would be set and the row
 *     wouldn't be in scope here.
 *
 * Set ORDER_AUTO_CANCEL_MINUTES=0 in system_configs to disable.
 */
@Injectable()
export class OrdersStalePendingCron {
  private readonly logger = new Logger(OrdersStalePendingCron.name);

  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    private readonly config: SystemConfigService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    try {
      const minutes = await this.config.getNumber(
        ConfigKey.ORDER_AUTO_CANCEL_MINUTES,
        60,
      );
      if (minutes <= 0) return; // disabled

      const cutoff = new Date(Date.now() - minutes * 60_000);
      const result = await this.orders.update(
        {
          status: OrderStatus.PENDING,
          driverId: IsNull(),
          createdAt: LessThan(cutoff),
        },
        { status: OrderStatus.CANCELLED },
      );
      if ((result.affected ?? 0) > 0) {
        this.logger.log(
          `Stale-pending sweep — cancelled ${result.affected} order(s) older than ${minutes} min.`,
        );
      }
    } catch (err) {
      this.logger.error(`Stale-pending sweep failed: ${String(err)}`);
    }
  }
}
