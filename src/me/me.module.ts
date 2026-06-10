import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApprovalsModule } from '../approvals/approvals.module';
import { Document } from '../documents/entities/document.entity';
import { DriverProfile } from '../drivers/entities/driver-profile.entity';
import { Order } from '../orders/entities/order.entity';
import { Transaction } from '../wallet/entities/transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { User } from '../users/entities/user.entity';
import { StorageCryptoService } from '../storage/crypto.service';
import { MeController } from './me.controller';
import { MeCron } from './me.cron';
import { MeService } from './me.service';

/**
 * I1 — NDPA data-subject-rights module. Owns:
 *   - `POST /me/export`, `POST /me/delete`, `DELETE /me/delete`,
 *     `POST /me/consent`.
 *   - Daily cron that pseudonymises users past their 30-day grace.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Order,
      Document,
      Wallet,
      Transaction,
      DriverProfile,
    ]),
    ApprovalsModule,
  ],
  controllers: [MeController],
  providers: [MeService, MeCron, StorageCryptoService],
  exports: [MeService],
})
export class MeModule {}
