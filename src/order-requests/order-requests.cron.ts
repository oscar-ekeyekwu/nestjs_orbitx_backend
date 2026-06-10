import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderRequestsService } from './order-requests.service';

/**
 * Sweeps OrderRequests past their 5-min TTL and DispatchOffers past
 * their 60-sec TTL. Runs every 30 seconds so the worst-case lag on
 * any TTL state transition is bounded by the cron tick — the
 * customer's "Searching…" screen won't sit stuck for more than ~30s
 * after the timer logically expired.
 */
@Injectable()
export class OrderRequestsExpiryCron {
  private readonly logger = new Logger(OrderRequestsExpiryCron.name);

  constructor(private readonly service: OrderRequestsService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweep(): Promise<void> {
    try {
      await this.service.sweepExpired();
    } catch (err) {
      this.logger.error(`Expiry sweep failed: ${String(err)}`);
    }
  }
}
