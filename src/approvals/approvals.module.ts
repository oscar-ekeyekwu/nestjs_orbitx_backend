import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApprovalDecision } from './entities/approval-decision.entity';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController } from './approvals.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ApprovalDecision])],
  providers: [ApprovalsService],
  controllers: [ApprovalsController],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
