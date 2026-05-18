import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Company, CompanyStatus } from './entities/company.entity';
import {
  ApprovalAction,
  ApprovalDecision,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
import { companyStateMachine } from './company-state-machine';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyStatusDto } from './dto/update-company-status.dto';
import { ErrorCodes } from '../common/constants/error-codes';
import { UserRole } from '../common/enums/user-role.enum';
import { User } from '../users/entities/user.entity';

/**
 * Maps a target status to the audit action recorded against the company.
 * Only the three edges the company state machine permits are reachable:
 *
 *   pending   → approved   ⇒ APPROVE
 *   approved  → suspended  ⇒ SUSPEND
 *   suspended → approved   ⇒ RESUME
 *
 * The `assertTransition` call upstream guarantees an illegal edge
 * throws before this helper is consulted, so the fallthrough is a
 * defensive default that should never fire at runtime.
 */
function approvalActionFor(
  fromStatus: CompanyStatus,
  toStatus: CompanyStatus,
): ApprovalAction {
  if (toStatus === CompanyStatus.APPROVED) {
    return fromStatus === CompanyStatus.PENDING
      ? ApprovalAction.APPROVE
      : ApprovalAction.RESUME;
  }
  if (toStatus === CompanyStatus.SUSPENDED) {
    return ApprovalAction.SUSPEND;
  }
  return ApprovalAction.SUSPEND;
}

@Injectable()
export class CompaniesService {
  constructor(
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Create a new company in `pending` status, owned by the calling user.
   *
   * Per architecture §1.1, every company has a single `created_by` user.
   * v1 ships with the company_memberships seam already in place, but B1
   * doesn't write to it — that's B4's job. Linking the calling driver's
   * driver_profile.companyId is B2's job. B1 just lands the row.
   */
  async create(dto: CreateCompanyDto, createdBy: string): Promise<Company> {
    const company = this.companyRepo.create({
      legalName: dto.legalName,
      cacNumber: dto.cacNumber ?? null,
      tin: dto.tin ?? null,
      address: dto.address ?? null,
      status: CompanyStatus.PENDING,
      createdBy,
    });
    return this.companyRepo.save(company);
  }

  async findById(id: string): Promise<Company> {
    const company = await this.companyRepo.findOne({ where: { id } });
    if (!company) {
      throw new NotFoundException(`Company ${id} not found`);
    }
    return company;
  }

  /**
   * Caller-aware read: admins see everything; non-admin users may only
   * read a company they created. Returns the company or throws 403 /
   * 404 in line with the platform's error envelope.
   */
  async findByIdForUser(id: string, caller: User): Promise<Company> {
    const company = await this.findById(id);
    if (caller.role === UserRole.ADMIN) {
      return company;
    }
    if (company.createdBy !== caller.id) {
      throw new ForbiddenException('You can only view companies you created.');
    }
    return company;
  }

  /** Admin-only paginated listing. */
  async findAll(opts?: {
    status?: CompanyStatus;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Company[]; total: number }> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const [items, total] = await this.companyRepo.findAndCount({
      where: opts?.status ? { status: opts.status } : undefined,
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }

  /**
   * Transition a company's status. Wraps the state-machine assertion +
   * row write + audit-decision write in a single transaction so the
   * audit ledger and the live status can never disagree (the canonical
   * ARCH-3 pattern).
   *
   * `caller` is the admin issuing the change — recorded as the reviewer
   * on the approval_decisions row.
   */
  async transitionStatus(
    companyId: string,
    dto: UpdateCompanyStatusDto,
    caller: User,
  ): Promise<Company> {
    return this.dataSource.transaction(async (manager) => {
      const company = await manager.findOne(Company, {
        where: { id: companyId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!company) {
        throw new NotFoundException(`Company ${companyId} not found`);
      }

      // ARCH-3: assert BEFORE mutating. Throws BadRequestException with
      // errorCode COMPANY_001 if the edge isn't in the state graph.
      companyStateMachine.assertTransition(
        company.status,
        dto.status,
        ErrorCodes.COMPANY_001,
      );

      const previousStatus = company.status;
      company.status = dto.status;
      await manager.save(company);

      await manager.insert(ApprovalDecision, {
        targetType: ApprovalTargetType.COMPANY,
        targetId: company.id,
        action: approvalActionFor(previousStatus, dto.status),
        reviewerId: caller.id,
        reason: dto.reason ?? null,
      });

      return company;
    });
  }
}
