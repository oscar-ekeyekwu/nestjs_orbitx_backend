import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PayoutsService } from './payouts.service';

/**
 * G4 — weekly payout cron. Fires every Monday 00:00 Africa/Lagos:
 *   1. Materializes a Payout row for each eligible recipient.
 *   2. Fans the new rows out to auto / manual destinations.
 *
 * Both steps are idempotent on their own (the (recipient, periodStart)
 * unique constraint catches duplicates; dispatchPending only touches
 * rows in PENDING state). A failed run is safe to re-trigger manually.
 */
@Injectable()
export class PayoutsCron {
  private readonly logger = new Logger(PayoutsCron.name);

  constructor(private readonly payouts: PayoutsService) {}

  @Cron('0 0 * * MON', { timeZone: 'Africa/Lagos' })
  async runWeekly(): Promise<void> {
    this.logger.log('Weekly payout cron starting (Mon 00:00 Africa/Lagos)');
    try {
      const created = await this.payouts.generateWeeklyPayouts();
      const dispatched = await this.payouts.dispatchPending();
      this.logger.log(
        `Payout cron complete — created=${created.length}, ` +
          `auto=${dispatched.auto}, manual=${dispatched.manual}, failed=${dispatched.failed}`,
      );
    } catch (err) {
      this.logger.error(`Payout cron failed: ${err}`);
    }
  }
}
