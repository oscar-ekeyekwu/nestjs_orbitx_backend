import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { EntityManager } from 'typeorm';
import { Repository } from 'typeorm';
import {
  ApprovalAction,
  ApprovalDecision,
  ApprovalTargetType,
} from './entities/approval-decision.entity';
import { ListApprovalDecisionsDto } from './dto/list-approval-decisions.dto';

export interface RecordDecisionInput {
  targetType: ApprovalTargetType;
  targetId: string;
  action: ApprovalAction;
  reviewerId: string;
  reason?: string | null;
}

/**
 * C6 — single insert point for the append-only approval ledger.
 *
 * The service deliberately exposes ONLY a `recordDecision` write
 * method + read-only `list` / `findByTarget`. There is NO update or
 * delete method; the ARCH-7 audit immutability guard ALSO blocks
 * UPDATE / DELETE at the DB role level (SYS_005), so an accidental
 * QueryBuilder elsewhere in the codebase still fails loudly.
 *
 * Callers MUST pass the same EntityManager they're using for the
 * status mutation so the insert lands in the same DB transaction.
 * That keeps the audit ledger and the live entity status in lockstep
 * — a key invariant for LASAA / NDPR compliance traces.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    @InjectRepository(ApprovalDecision)
    private readonly repo: Repository<ApprovalDecision>,
  ) {}

  /**
   * Insert a decision row using the supplied EntityManager. Callers
   * are expected to be inside `dataSource.transaction(async manager =>
   * { ... })` already; this helper just standardizes the row shape.
   */
  async recordDecision(
    manager: EntityManager,
    input: RecordDecisionInput,
  ): Promise<void> {
    await manager.insert(ApprovalDecision, {
      targetType: input.targetType,
      targetId: input.targetId,
      action: input.action,
      reviewerId: input.reviewerId,
      reason: input.reason ?? null,
    });
  }

  /**
   * Admin-only ledger listing. Filters compose with AND. Always
   * returns results ordered by decidedAt DESC so the most recent
   * decisions surface first.
   */
  async list(
    filters: ListApprovalDecisionsDto,
    opts?: { limit?: number; offset?: number },
  ): Promise<{ items: ApprovalDecision[]; total: number }> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    const where: Record<string, unknown> = {};
    if (filters.targetType) where.targetType = filters.targetType;
    if (filters.targetId) where.targetId = filters.targetId;
    if (filters.reviewerId) where.reviewerId = filters.reviewerId;
    if (filters.action) where.action = filters.action;

    const [items, total] = await this.repo.findAndCount({
      where,
      order: { decidedAt: 'DESC' },
      take: limit,
      skip: offset,
      relations: ['reviewer'],
    });
    return { items, total };
  }

  /** Convenience: the full audit trail for a single target. */
  async findByTarget(
    targetType: ApprovalTargetType,
    targetId: string,
  ): Promise<ApprovalDecision[]> {
    return this.repo.find({
      where: { targetType, targetId },
      order: { decidedAt: 'DESC' },
    });
  }
}
