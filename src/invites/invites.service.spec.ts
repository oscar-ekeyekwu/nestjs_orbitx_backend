/* eslint-disable @typescript-eslint/unbound-method --
 * jest mock introspection is noisy under strict type-checked lint. */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { InvitesService } from './invites.service';
import { DriverInvite } from './entities/driver-invite.entity';
import { Company, CompanyStatus } from '../companies/entities/company.entity';
import { ErrorCodes } from '../common/constants/error-codes';
import { UserRole } from '../common/enums/user-role.enum';
import type { User } from '../users/entities/user.entity';

const OWNER: User = {
  id: 'owner-1',
  email: 'owner@example.com',
  role: UserRole.DRIVER,
} as unknown as User;

const ADMIN: User = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: UserRole.ADMIN,
} as unknown as User;

const OUTSIDER: User = {
  id: 'outsider-1',
  email: 'someone@else.com',
  role: UserRole.DRIVER,
} as unknown as User;

function buildCompany(overrides: Partial<Company>): Company {
  return {
    id: 'company-1',
    legalName: 'Adebayo Logistics',
    cacNumber: 'RC123',
    tin: null,
    address: null,
    status: CompanyStatus.APPROVED,
    createdBy: OWNER.id,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Company;
}

function extractErrorCode(err: unknown): string | undefined {
  if (!(err instanceof BadRequestException)) return undefined;
  const res = err.getResponse();
  if (typeof res === 'object' && res !== null && 'errorCode' in res) {
    return (res as { errorCode: string }).errorCode;
  }
  return undefined;
}

describe('InvitesService (D4)', () => {
  let inviteRepo: jest.Mocked<Repository<DriverInvite>>;
  let companyRepo: jest.Mocked<Repository<Company>>;
  let sms: { sendSms: jest.Mock };
  let service: InvitesService;

  beforeEach(() => {
    inviteRepo = {
      create: jest.fn((dto: Partial<DriverInvite>) => ({
        ...dto,
        id: 'invite-1',
        token: 'token-1',
      })),
      save: jest.fn((inv: DriverInvite) => Promise.resolve(inv)),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<DriverInvite>>;

    companyRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Company>>;

    sms = { sendSms: jest.fn().mockResolvedValue({ success: true }) };

    service = new InvitesService(inviteRepo, companyRepo, sms as never);
  });

  describe('createInvite', () => {
    it('owner of an approved company can mint an invite + SMS fires', async () => {
      companyRepo.findOne.mockResolvedValue(buildCompany({}));

      const result = await service.createInvite(
        'company-1',
        '+2348012345678',
        OWNER,
      );

      expect(result.inviteUrl).toMatch(/^orbitx:\/\/invite\//);
      expect(inviteRepo.save).toHaveBeenCalled();
      // SMS dispatch is fire-and-forget — give the microtask a tick
      // to settle then assert. The service awaits internally, just
      // not on the caller's promise.
      await Promise.resolve();
      expect(sms.sendSms).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('orbitx://invite/'),
      );
    });

    it('admin can mint for any company', async () => {
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      await expect(
        service.createInvite('company-1', '+2348012345678', ADMIN),
      ).resolves.toBeDefined();
    });

    it('outsider (non-owner, non-admin) gets 403', async () => {
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      await expect(
        service.createInvite('company-1', '+2348012345678', OUTSIDER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(inviteRepo.save).not.toHaveBeenCalled();
    });

    it('refuses to mint when the company is not approved (COMPANY_001)', async () => {
      companyRepo.findOne.mockResolvedValue(
        buildCompany({ status: CompanyStatus.PENDING }),
      );

      let caught: unknown;
      try {
        await service.createInvite('company-1', '+2348012345678', OWNER);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(extractErrorCode(caught)).toBe(ErrorCodes.COMPANY_001);
    });

    it('404 when the company does not exist', async () => {
      companyRepo.findOne.mockResolvedValue(null);
      await expect(
        service.createInvite('missing', '+2348012345678', OWNER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('SMS failure does NOT roll back the invite (best-effort dispatch)', async () => {
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      sms.sendSms.mockRejectedValueOnce(new Error('twilio down'));

      const result = await service.createInvite(
        'company-1',
        '+2348012345678',
        OWNER,
      );

      expect(result.inviteUrl).toBeDefined();
      expect(inviteRepo.save).toHaveBeenCalled();
    });
  });

  describe('redeemInTransaction', () => {
    type TxManager = {
      findOne: jest.Mock;
      save: jest.Mock;
    };

    function buildInvite(overrides: Partial<DriverInvite>): DriverInvite {
      return {
        id: 'invite-1',
        companyId: 'company-1',
        phone: '+2348012345678',
        token: 'token-good',
        expiresAt: new Date(Date.now() + 86_400_000),
        usedAt: null,
        redeemedByUserId: null,
        createdBy: OWNER.id,
        createdAt: new Date(),
        ...overrides,
      } as unknown as DriverInvite;
    }

    function buildManager(invite: DriverInvite | null): TxManager {
      return {
        findOne: jest.fn().mockResolvedValue(invite),
        save: jest.fn((inv: DriverInvite) => Promise.resolve(inv)),
      };
    }

    it('happy path: returns companyId + marks the invite used', async () => {
      const invite = buildInvite({});
      const manager = buildManager(invite);

      const result = await service.redeemInTransaction(
        manager as never,
        'token-good',
        'new-user-id',
      );

      expect(result.companyId).toBe('company-1');
      expect(result.inviteId).toBe('invite-1');
      expect(invite.usedAt).toBeInstanceOf(Date);
      expect(invite.redeemedByUserId).toBe('new-user-id');
      expect(manager.save).toHaveBeenCalled();
    });

    it('INVITE_003: unknown token surfaces invalid', async () => {
      const manager = buildManager(null);

      let caught: unknown;
      try {
        await service.redeemInTransaction(
          manager as never,
          'token-bogus',
          'new-user-id',
        );
      } catch (err) {
        caught = err;
      }
      expect(extractErrorCode(caught)).toBe(ErrorCodes.INVITE_003);
    });

    it('INVITE_002: already-used token rejects', async () => {
      const invite = buildInvite({ usedAt: new Date(Date.now() - 60_000) });
      const manager = buildManager(invite);

      let caught: unknown;
      try {
        await service.redeemInTransaction(
          manager as never,
          'token-used',
          'new-user-id',
        );
      } catch (err) {
        caught = err;
      }
      expect(extractErrorCode(caught)).toBe(ErrorCodes.INVITE_002);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('INVITE_001: expired token rejects', async () => {
      const invite = buildInvite({
        expiresAt: new Date(Date.now() - 60_000),
      });
      const manager = buildManager(invite);

      let caught: unknown;
      try {
        await service.redeemInTransaction(
          manager as never,
          'token-expired',
          'new-user-id',
        );
      } catch (err) {
        caught = err;
      }
      expect(extractErrorCode(caught)).toBe(ErrorCodes.INVITE_001);
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('listForCompany', () => {
    it('owner sees their company invites', async () => {
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      await service.listForCompany('company-1', OWNER);
      expect(inviteRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { companyId: 'company-1' },
          order: { createdAt: 'DESC' },
        }),
      );
    });

    it('outsider gets 403', async () => {
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      await expect(
        service.listForCompany('company-1', OUTSIDER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
