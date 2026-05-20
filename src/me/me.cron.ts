import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MeService } from './me.service';

/**
 * I1 — daily 02:00 Africa/Lagos sweep that pseudonymises every user
 * past their 30-day deletion grace. Cron timing mirrors the existing
 * document-expiry cron so ops only need to monitor one nightly
 * maintenance window.
 */
@Injectable()
export class MeCron {
  private readonly logger = new Logger(MeCron.name);

  constructor(private readonly me: MeService) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM, { timeZone: 'Africa/Lagos' })
  async runDeletionSweep(): Promise<void> {
    try {
      const result = await this.me.sweepScheduledDeletions();
      this.logger.log(
        `NDPA sweep complete: pseudonymised=${result.sweptUserIds.length}`,
      );
    } catch (err) {
      this.logger.error(`NDPA sweep crashed: ${(err as Error).message}`);
    }
  }
}
