import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../orders/entities/order.entity';
import { Incident } from './entities/incident.entity';
import { IncidentsController } from './incidents.controller';
import { IncidentsService } from './incidents.service';

/**
 * I6 — driver SOS + incident workflow. Owns:
 *   - incidents table (entity + TypeORM repo)
 *   - lifecycle service: raise / acknowledge / close
 *   - admin + driver controller surface
 *
 * Emits `incident.raised` and `incident.acknowledged` events; the
 * push-fanout subscribers (ARCH-10 / J1) translate those into
 * admin / driver notifications. Customer-facing tracking screen
 * reads `orders.incidentFlagged` to render the monitoring banner.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Incident, Order])],
  controllers: [IncidentsController],
  providers: [IncidentsService],
  exports: [IncidentsService],
})
export class IncidentsModule {}
