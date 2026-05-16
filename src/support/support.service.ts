import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SupportTicket } from './entities/support-ticket.entity';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';
import { UpdateSupportTicketDto } from './dto/update-support-ticket.dto';
import { GetSupportTicketsQueryDto } from './dto/get-support-tickets-query.dto';
import {
  PaginatedResult,
  createPaginatedResponse,
} from '../common/dto/pagination.dto';

@Injectable()
export class SupportService {
  constructor(
    @InjectRepository(SupportTicket)
    private readonly ticketRepo: Repository<SupportTicket>,
  ) {}

  async create(
    userId: string,
    dto: CreateSupportTicketDto,
  ): Promise<SupportTicket> {
    const ticket = this.ticketRepo.create({
      userId,
      subject: dto.subject,
      description: dto.description,
      priority: dto.priority,
      orderId: dto.orderId ?? null,
    });
    const saved = await this.ticketRepo.save(ticket);
    return this.findOne(saved.id);
  }

  async findAll(
    query: GetSupportTicketsQueryDto,
  ): Promise<PaginatedResult<SupportTicket>> {
    const qb = this.ticketRepo
      .createQueryBuilder('ticket')
      .leftJoinAndSelect('ticket.user', 'user');

    if (query.status) {
      qb.andWhere('ticket.status = :status', { status: query.status });
    }
    if (query.priority) {
      qb.andWhere('ticket.priority = :priority', { priority: query.priority });
    }
    if (query.search) {
      qb.andWhere(
        '(ticket.subject ILIKE :search OR ticket.description ILIKE :search)',
        { search: `%${query.search}%` },
      );
    }

    qb.orderBy('ticket.createdAt', 'DESC').skip(query.skip).take(query.limit);

    const [data, total] = await qb.getManyAndCount();
    return createPaginatedResponse(data, total, query.page!, query.limit!);
  }

  async findOne(id: string): Promise<SupportTicket> {
    const ticket = await this.ticketRepo.findOne({ where: { id } });
    if (!ticket) {
      throw new NotFoundException(`Support ticket ${id} not found`);
    }
    return ticket;
  }

  async update(
    id: string,
    dto: UpdateSupportTicketDto,
  ): Promise<SupportTicket> {
    const ticket = await this.findOne(id);
    Object.assign(ticket, dto);
    await this.ticketRepo.save(ticket);
    return this.findOne(id);
  }
}
