/* eslint-disable @typescript-eslint/unbound-method,
                  @typescript-eslint/no-unsafe-member-access --
 * jest mock introspection is noisy under strict type-checked lint. */
import type { EntityManager } from 'typeorm';
import { Repository } from 'typeorm';
import { ApprovalsService } from './approvals.service';
import {
  ApprovalAction,
  ApprovalDecision,
  ApprovalTargetType,
} from './entities/approval-decision.entity';

describe('ApprovalsService (C6)', () => {
  let repo: jest.Mocked<Repository<ApprovalDecision>>;
  let service: ApprovalsService;

  beforeEach(() => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    } as unknown as jest.Mocked<Repository<ApprovalDecision>>;

    service = new ApprovalsService(repo);
  });

  describe('recordDecision', () => {
    it('inserts the row via the supplied EntityManager — never the repo', async () => {
      const manager = {
        insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'ap-1' }] }),
      } as unknown as EntityManager;

      await service.recordDecision(manager, {
        targetType: ApprovalTargetType.DRIVER,
        targetId: 'driver-1',
        action: ApprovalAction.APPROVE,
        reviewerId: 'admin-1',
        reason: 'license + NIN verified',
      });

      expect(manager.insert).toHaveBeenCalledWith(
        ApprovalDecision,
        expect.objectContaining({
          targetType: ApprovalTargetType.DRIVER,
          targetId: 'driver-1',
          action: ApprovalAction.APPROVE,
          reviewerId: 'admin-1',
          reason: 'license + NIN verified',
        }),
      );
    });

    it('normalizes undefined reason to null in the row', async () => {
      const manager = {
        insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'ap-1' }] }),
      } as unknown as EntityManager;

      await service.recordDecision(manager, {
        targetType: ApprovalTargetType.COMPANY,
        targetId: 'company-1',
        action: ApprovalAction.APPROVE,
        reviewerId: 'admin-1',
      });

      const insertArg = (manager.insert as jest.Mock).mock.calls[0][1] as {
        reason: unknown;
      };
      expect(insertArg.reason).toBeNull();
    });
  });

  describe('immutability (C6 / NFR-S5)', () => {
    it('exposes no update or delete method on the service surface', () => {
      // Methods on the public API ↓ — keep this list narrow on purpose.
      const expectedKeys = new Set(['recordDecision', 'list', 'findByTarget']);

      const ownKeys = Object.getOwnPropertyNames(
        Object.getPrototypeOf(service) as object,
      ).filter((k) => k !== 'constructor');

      const forbidden = ['update', 'delete', 'remove', 'softDelete'];
      for (const key of forbidden) {
        expect(ownKeys).not.toContain(key);
      }
      for (const k of ownKeys) {
        expect(expectedKeys.has(k)).toBe(true);
      }
    });
  });

  describe('list', () => {
    it('applies all four filters when supplied', async () => {
      await service.list(
        {
          targetType: ApprovalTargetType.DRIVER,
          targetId: 'driver-1',
          reviewerId: 'admin-1',
          action: ApprovalAction.REJECT,
        },
        { limit: 20, offset: 40 },
      );

      expect(repo.findAndCount).toHaveBeenCalledWith({
        where: {
          targetType: ApprovalTargetType.DRIVER,
          targetId: 'driver-1',
          reviewerId: 'admin-1',
          action: ApprovalAction.REJECT,
        },
        order: { decidedAt: 'DESC' },
        take: 20,
        skip: 40,
        relations: ['reviewer'],
      });
    });

    it('empty filter passes an empty where and uses default paging', async () => {
      await service.list({});
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {},
          take: 50,
          skip: 0,
          order: { decidedAt: 'DESC' },
        }),
      );
    });
  });

  describe('findByTarget', () => {
    it('queries by composite target key, newest first', async () => {
      await service.findByTarget(ApprovalTargetType.VEHICLE, 'v-1');
      expect(repo.find).toHaveBeenCalledWith({
        where: { targetType: ApprovalTargetType.VEHICLE, targetId: 'v-1' },
        order: { decidedAt: 'DESC' },
      });
    });
  });
});
