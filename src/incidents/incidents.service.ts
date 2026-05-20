import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Order } from '../orders/entities/order.entity';
import { CloseIncidentDto } from './dto/close-incident.dto';
import { RaiseSosDto } from './dto/raise-sos.dto';
import { Incident, IncidentStatus } from './entities/incident.entity';

/**
 * I6 — SOS lifecycle service.
 *
 * raise()      → driver-only. Validates the order belongs to caller,
 *                inserts the incident, flips orders.incidentFlagged.
 *                Emits `incident.raised` for admin push fanout.
 * acknowledge()→ admin-only. Time-to-acknowledge is captured for the
 *                weekly SLA review. Emits `incident.acknowledged` so
 *                the driver gets a confirmation push.
 * close()      → admin-only. Requires outcome + note. Clears the
 *                order's incidentFlagged once the LAST incident on
 *                that order closes.
 */
@Injectable()
export class IncidentsService {
  private readonly logger = new Logger(IncidentsService.name);

  constructor(
    @InjectRepository(Incident)
    private readonly incidents: Repository<Incident>,
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    private readonly dataSource: DataSource,
    private readonly events: EventEmitter2,
  ) {}

  async list(filters?: { status?: IncidentStatus }): Promise<Incident[]> {
    return this.incidents.find({
      where: filters?.status ? { status: filters.status } : {},
      order: { raisedAt: 'DESC' },
      take: 100,
    });
  }

  async findOne(id: string): Promise<Incident> {
    const row = await this.incidents.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Incident ${id} not found.`);
    return row;
  }

  async raise(dto: RaiseSosDto, driverUserId: string): Promise<Incident> {
    const order = await this.orders.findOne({ where: { id: dto.orderId } });
    if (!order) {
      throw new NotFoundException(`Order ${dto.orderId} not found.`);
    }
    if (order.driverId !== driverUserId) {
      throw new BadRequestException({
        code: 'INCIDENT_001',
        message: 'You can only raise an SOS on your own active delivery.',
      });
    }

    const created = await this.dataSource.transaction(async (manager) => {
      const incident = await manager.save(Incident, {
        orderId: dto.orderId,
        driverId: driverUserId,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        status: IncidentStatus.OPEN,
      });
      await manager.update(
        Order,
        { id: dto.orderId },
        { incidentFlagged: true },
      );
      return incident;
    });

    this.logger.warn(
      `Incident raised: id=${created.id} order=${dto.orderId} driver=${driverUserId}`,
    );
    this.events.emit('incident.raised', {
      incidentId: created.id,
      orderId: dto.orderId,
      driverId: driverUserId,
      latitude: dto.latitude,
      longitude: dto.longitude,
    });
    return created;
  }

  async acknowledge(id: string, adminUserId: string): Promise<Incident> {
    const row = await this.findOne(id);
    if (row.status !== IncidentStatus.OPEN) {
      throw new BadRequestException(
        `Incident ${id} is not open (current status: ${row.status}).`,
      );
    }
    row.status = IncidentStatus.ACKNOWLEDGED;
    row.acknowledgedAt = new Date();
    row.acknowledgedBy = adminUserId;
    await this.incidents.save(row);

    const elapsedMs =
      row.acknowledgedAt.getTime() - new Date(row.raisedAt).getTime();
    this.logger.log(
      `Incident acknowledged: id=${id} by=${adminUserId} timeToAckMs=${elapsedMs}`,
    );
    this.events.emit('incident.acknowledged', {
      incidentId: id,
      driverId: row.driverId,
      orderId: row.orderId,
      timeToAcknowledgeMs: elapsedMs,
    });
    return row;
  }

  async close(
    id: string,
    dto: CloseIncidentDto,
    adminUserId: string,
  ): Promise<Incident> {
    const closedRow = await this.dataSource.transaction(async (manager) => {
      const row = await manager.findOne(Incident, { where: { id } });
      if (!row) throw new NotFoundException(`Incident ${id} not found.`);
      if (row.status === IncidentStatus.CLOSED) {
        throw new BadRequestException(`Incident ${id} is already closed.`);
      }
      row.status = IncidentStatus.CLOSED;
      row.outcome = dto.outcome;
      row.outcomeNote = dto.outcomeNote;
      row.closedAt = new Date();
      row.closedBy = adminUserId;
      await manager.save(row);

      // Clear the order's incidentFlagged flag if no other open
      // incidents remain on that order.
      const openOnOrder = await manager.count(Incident, {
        where: { orderId: row.orderId, status: IncidentStatus.OPEN },
      });
      const ackOnOrder = await manager.count(Incident, {
        where: { orderId: row.orderId, status: IncidentStatus.ACKNOWLEDGED },
      });
      if (openOnOrder === 0 && ackOnOrder === 0) {
        await manager.update(
          Order,
          { id: row.orderId },
          { incidentFlagged: false },
        );
      }
      return row;
    });

    this.logger.log(
      `Incident closed: id=${id} outcome=${dto.outcome} by=${adminUserId}`,
    );
    return closedRow;
  }
}
