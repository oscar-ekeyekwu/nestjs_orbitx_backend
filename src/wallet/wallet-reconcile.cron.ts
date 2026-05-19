import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WalletReconcileService } from './wallet-reconcile.service';

/**
 * G6 — nightly wallet-reconcile cron. Fires every day at 02:00
 * Africa/Lagos so any drift introduced during the previous day is
 * detected within hours of occurring.
 */
@Injectable()
export class WalletReconcileCron {
  private readonly logger = new Logger(WalletReconcileCron.name);

  constructor(private readonly reconcile: WalletReconcileService) {}

  @Cron('0 2 * * *', { timeZone: 'Africa/Lagos' })
  async runNightly(): Promise<void> {
    this.logger.log('Wallet reconcile starting (02:00 Africa/Lagos)');
    try {
      const report = await this.reconcile.reconcileAll();
      this.logger.log(
        `Wallet reconcile finished — wallets=${report.walletsChecked} mismatches=${report.mismatches.length}`,
      );
    } catch (err) {
      this.logger.error(`Wallet reconcile failed: ${err}`);
    }
  }
}
