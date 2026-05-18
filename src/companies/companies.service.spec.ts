/* eslint-disable @typescript-eslint/no-unsafe-member-access --
 * jest's `.mock.calls[N][M]` introspection is `any[][]` by design;
 * the unsafe-access rule is noisy on legitimate mock assertions in
 * this spec. */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { CompaniesService } from './companies.service';
import { Company, CompanyStatus } from './entities/company.entity';
import {
  ApprovalAction,
  ApprovalDecision,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
import { ApprovalsService } from '../approvals/approvals.service';
import { ErrorCodes } from '../common/constants/error-codes';
import { UserRole } from '../common/enums/user-role.enum';
import type { User } from '../users/entities/user.entity';

interface InsertCall {
  entity: unknown;
  values: Record<string, unknown>;
}

function buildSavedCompany(overrides: Partial<Company>): Company {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    legalName: 'Adebayo Logistics',
    cacNumber: 'RC123',
    tin: null,
    address: null,
    status: CompanyStatus.PENDING,
    createdBy: 'user-1',
    createdAt: new Date('2026-05-18T10:00:00Z'),
    updatedAt: new Date('2026-05-18T10:00:00Z'),
    ...overrides,
  } as unknown as Company;
}

function buildUser(overrides: Partial<User>): User {
  return {
    id: 'user-1',
    email: 'tunde@example.com',
    role: UserRole.DRIVER,
    ...overrides,
  } as unknown as User;
}

describe('CompaniesService (B1)', () => {
  let service: CompaniesService;
  let companyRepo: jest.Mocked<Repository<Company>>;
  let dataSource: { transaction: jest.Mock };
  let txManager: {
    findOne: jest.Mock;
    save: jest.Mock;
    insert: jest.Mock;
  };
  let insertCalls: InsertCall[];

  beforeEach(() => {
    companyRepo = {
      create: jest.fn((dto: Partial<Company>) => dto as Company),
      save: jest.fn(),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
    } as unknown as jest.Mocked<Repository<Company>>;

    insertCalls = [];
    txManager = {
      findOne: jest.fn(),
      save: jest.fn((entity: unknown) => Promise.resolve(entity)),
      insert: jest.fn((entity: unknown, values: Record<string, unknown>) => {
        insertCalls.push({ entity, values });
        return Promise.resolve({ identifiers: [], generatedMaps: [] });
      }),
    };

    dataSource = {
      transaction: jest.fn(
        (cb: (manager: EntityManager) => Promise<unknown>): Promise<unknown> =>
          cb(txManager as unknown as EntityManager),
      ),
    };

    // C6: ApprovalsService is the single insert point for the ledger.
    // We instantiate it with a stub repo so its `recordDecision` still
    // calls manager.insert(ApprovalDecision, ...) through the supplied
    // EntityManager — keeping the existing insertCalls assertions valid.
    const approvalsService = new ApprovalsService({
      find: jest.fn(),
      findAndCount: jest.fn(),
    } as unknown as Repository<ApprovalDecision>);

    service = new CompaniesService(
      companyRepo,
      dataSource as unknown as DataSource,
      approvalsService,
    );
  });

  describe('create', () => {
    it('creates a company with status=PENDING and the caller as createdBy', async () => {
      const saved = buildSavedCompany({});
      (companyRepo.save as jest.Mock).mockResolvedValue(saved);

      const result = await service.create(
        {
          legalName: 'Adebayo Logistics',
          cacNumber: 'RC123',
        },
        'user-1',
      );

      const createCall = (companyRepo.create as jest.Mock).mock
        .calls[0][0] as Record<string, unknown>;
      expect(createCall.status).toBe(CompanyStatus.PENDING);
      expect(createCall.createdBy).toBe('user-1');
      expect(createCall.legalName).toBe('Adebayo Logistics');
      expect(createCall.cacNumber).toBe('RC123');
      // Optional fields default to null when omitted from the DTO.
      expect(createCall.tin).toBeNull();
      expect(createCall.address).toBeNull();
      expect(result).toBe(saved);
    });
  });

  describe('findByIdForUser (caller-aware read)', () => {
    it('returns the company when caller is the creator', async () => {
      const saved = buildSavedCompany({ createdBy: 'user-1' });
      (companyRepo.findOne as jest.Mock).mockResolvedValue(saved);

      const result = await service.findByIdForUser(
        saved.id,
        buildUser({ id: 'user-1' }),
      );
      expect(result).toBe(saved);
    });

    it('returns the company when caller is admin (even if they are not creator)', async () => {
      const saved = buildSavedCompany({ createdBy: 'someone-else' });
      (companyRepo.findOne as jest.Mock).mockResolvedValue(saved);

      const result = await service.findByIdForUser(
        saved.id,
        buildUser({ id: 'admin-1', role: UserRole.ADMIN }),
      );
      expect(result).toBe(saved);
    });

    it('throws 403 when caller is neither creator nor admin', async () => {
      const saved = buildSavedCompany({ createdBy: 'someone-else' });
      (companyRepo.findOne as jest.Mock).mockResolvedValue(saved);

      await expect(
        service.findByIdForUser(saved.id, buildUser({ id: 'user-1' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws 404 when the company does not exist', async () => {
      (companyRepo.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        service.findByIdForUser('missing', buildUser({ id: 'user-1' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('returns { items, total } and respects the status / pagination filter', async () => {
      const rows = [buildSavedCompany({})];
      (companyRepo.findAndCount as jest.Mock).mockResolvedValue([rows, 1]);

      const result = await service.findAll({
        status: CompanyStatus.PENDING,
        limit: 10,
        offset: 0,
      });

      expect(result).toEqual({ items: rows, total: 1 });

      const arg = (companyRepo.findAndCount as jest.Mock).mock
        .calls[0][0] as Record<string, unknown>;
      expect(arg.where).toEqual({ status: CompanyStatus.PENDING });
      expect(arg.take).toBe(10);
      expect(arg.skip).toBe(0);
    });
  });

  describe('transitionStatus', () => {
    const admin = buildUser({ id: 'admin-1', role: UserRole.ADMIN });

    it('valid pending → approved: updates status AND writes an approval_decisions row in the same transaction', async () => {
      const company = buildSavedCompany({ status: CompanyStatus.PENDING });
      txManager.findOne.mockResolvedValue(company);

      const result = await service.transitionStatus(
        company.id,
        { status: CompanyStatus.APPROVED, reason: 'CAC verified' },
        admin,
      );

      expect(result.status).toBe(CompanyStatus.APPROVED);
      expect(txManager.save).toHaveBeenCalled();
      expect(insertCalls).toHaveLength(1);
      expect(insertCalls[0].entity).toBe(ApprovalDecision);
      expect(insertCalls[0].values).toEqual({
        targetType: ApprovalTargetType.COMPANY,
        targetId: company.id,
        action: ApprovalAction.APPROVE,
        reviewerId: 'admin-1',
        reason: 'CAC verified',
      });
    });

    it('valid approved → suspended: action is SUSPEND', async () => {
      const company = buildSavedCompany({ status: CompanyStatus.APPROVED });
      txManager.findOne.mockResolvedValue(company);

      await service.transitionStatus(
        company.id,
        { status: CompanyStatus.SUSPENDED, reason: 'TIN mismatch' },
        admin,
      );

      expect(insertCalls[0].values.action).toBe(ApprovalAction.SUSPEND);
    });

    it('valid suspended → approved: action is RESUME', async () => {
      const company = buildSavedCompany({ status: CompanyStatus.SUSPENDED });
      txManager.findOne.mockResolvedValue(company);

      await service.transitionStatus(
        company.id,
        { status: CompanyStatus.APPROVED },
        admin,
      );

      expect(insertCalls[0].values.action).toBe(ApprovalAction.RESUME);
    });

    it('rejects pending → suspended with COMPANY_001 (B1 AC: suspension only from approved)', async () => {
      const company = buildSavedCompany({ status: CompanyStatus.PENDING });
      txManager.findOne.mockResolvedValue(company);

      let caught: unknown;
      try {
        await service.transitionStatus(
          company.id,
          { status: CompanyStatus.SUSPENDED },
          admin,
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(BadRequestException);
      const response = (caught as BadRequestException).getResponse() as {
        errorCode: string;
      };
      expect(response.errorCode).toBe(ErrorCodes.COMPANY_001);

      // No decision row should be written when the assertion fails.
      expect(insertCalls).toHaveLength(0);
      expect(txManager.save).not.toHaveBeenCalled();
    });

    it('throws 404 when the company does not exist inside the transaction', async () => {
      txManager.findOne.mockResolvedValue(null);

      await expect(
        service.transitionStatus(
          'missing',
          { status: CompanyStatus.APPROVED },
          admin,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
