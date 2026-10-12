import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApprovalsModule } from '../approvals/approvals.module';
import { StorageModule } from '../storage/storage.module';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { UserPurgeService } from './user-purge.service';
import { User } from './entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User]), ApprovalsModule, StorageModule],
  controllers: [UsersController],
  providers: [UsersService, UserPurgeService],
  exports: [UsersService],
})
export class UsersModule {}
