import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DriverInvite } from './entities/driver-invite.entity';
import { Company } from '../companies/entities/company.entity';
import { InvitesService } from './invites.service';
import { InvitesController } from './invites.controller';
import { NotificationsModule } from '../notifications/notification.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DriverInvite, Company]),
    NotificationsModule,
  ],
  providers: [InvitesService],
  controllers: [InvitesController],
  exports: [InvitesService],
})
export class InvitesModule {}
