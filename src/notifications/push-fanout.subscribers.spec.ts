/* eslint-disable @typescript-eslint/unbound-method,
                  @typescript-eslint/no-unsafe-assignment --
 * jest mock introspection is noisy under strict type-checked lint;
 * mock-call destructuring trips no-unsafe-assignment unconditionally. */
import { PushFanoutEventSubscribers } from './push-fanout.subscribers';
import { PushFanoutService } from './push-fanout.service';
import { DocumentOwnerType } from '../documents/entities/document.entity';
import type { Repository } from 'typeorm';
import type { User } from '../users/entities/user.entity';

describe('PushFanoutEventSubscribers (ARCH-10)', () => {
  let fanout: jest.Mocked<PushFanoutService>;
  let users: jest.Mocked<Repository<User>>;
  let driverProfiles: { find: jest.Mock };
  let subs: PushFanoutEventSubscribers;

  beforeEach(() => {
    fanout = {
      send: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<PushFanoutService>;
    // I6 — incident subscribers fan out to all active admin user_ids.
    users = {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Repository<User>>;
    // order.created fans out to active+online drivers via this repo.
    // (Proximity dispatch uses createQueryBuilder, exercised separately in
    // push-fanout.order-created.spec.ts; the .find stub is unused here.)
    driverProfiles = { find: jest.fn().mockResolvedValue([]) };
    subs = new PushFanoutEventSubscribers(
      fanout,
      users,
      driverProfiles as never,
      {} as never,
      {} as never,
    );
  });

  describe('document.expiring_soon', () => {
    it('user ownerType → fan out to that user with daysRemaining in body', () => {
      subs.onExpiringSoon({
        documentId: 'doc-1',
        ownerType: DocumentOwnerType.USER,
        ownerId: 'user-1',
        type: 'drivers_license',
        daysRemaining: 7,
        expiryDate: '2026-05-25',
      });

      expect(fanout.send).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          notification: expect.objectContaining({
            title: 'Document expiring soon',
            body: expect.stringMatching(/7 day/),
          }),
          data: expect.objectContaining({
            kind: 'document.expiring_soon',
            daysRemaining: '7',
          }),
        }),
      );
    });

    it('vehicle ownerType → skipped (D2/D3/D4 will resolve later)', () => {
      subs.onExpiringSoon({
        documentId: 'doc-1',
        ownerType: DocumentOwnerType.VEHICLE,
        ownerId: 'v-1',
        type: 'insurance',
        daysRemaining: 30,
        expiryDate: '2026-06-17',
      });

      expect(fanout.send).not.toHaveBeenCalled();
    });

    it('uses friendly doc-type name in the body', () => {
      subs.onExpiringSoon({
        documentId: 'doc-1',
        ownerType: DocumentOwnerType.USER,
        ownerId: 'user-1',
        type: 'lasaa_permit',
        daysRemaining: 7,
        expiryDate: '2026-05-25',
      });
      const body = fanout.send.mock.calls[0][1].notification.body;
      expect(body).toContain('LASAA permit');
    });
  });

  describe('document.expired', () => {
    it('fires the expired notification on the owner', () => {
      subs.onExpired({
        documentId: 'doc-1',
        ownerType: DocumentOwnerType.USER,
        ownerId: 'user-1',
        type: 'insurance',
        expiryDate: '2026-05-17',
      });
      expect(fanout.send).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          notification: expect.objectContaining({
            title: 'Document expired',
          }),
        }),
      );
    });
  });

  describe('owner.suspended_docs_expired', () => {
    it('user ownerType → fan out with the account-suspended copy', () => {
      subs.onOwnerSuspended({
        ownerType: DocumentOwnerType.USER,
        ownerId: 'user-1',
        triggeringDocumentId: 'doc-1',
        triggeringDocType: 'drivers_license',
      });
      expect(fanout.send).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          notification: expect.objectContaining({
            title: 'Account suspended',
          }),
        }),
      );
    });
  });

  describe('C5 review-decision events', () => {
    it('document.approved → notifies the owner', () => {
      subs.onDocumentApproved({
        userId: 'user-1',
        documentId: 'doc-1',
        reason: null,
      });
      expect(fanout.send).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          notification: expect.objectContaining({
            title: 'Document approved',
          }),
          data: expect.objectContaining({
            kind: 'document.approved',
            documentId: 'doc-1',
          }),
        }),
      );
    });

    it('document.rejected with reason uses the reason as the body', () => {
      subs.onDocumentRejected({
        userId: 'user-1',
        documentId: 'doc-1',
        reason: 'Photo is blurry; please re-take.',
      });
      const body = fanout.send.mock.calls[0][1].notification.body;
      expect(body).toBe('Photo is blurry; please re-take.');
    });

    it('document.rejected without reason uses generic copy', () => {
      subs.onDocumentRejected({
        userId: 'user-1',
        documentId: 'doc-1',
        reason: null,
      });
      const body = fanout.send.mock.calls[0][1].notification.body;
      expect(body).toMatch(/rejected/i);
    });

    it('driver.approved → notifies the user', () => {
      subs.onDriverApproved({ userId: 'user-1' });
      expect(fanout.send).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          notification: expect.objectContaining({
            title: 'Verification approved',
          }),
        }),
      );
    });

    it('driver.rejected uses the reason when present', () => {
      subs.onDriverRejected({
        userId: 'user-1',
        reason: 'License image unreadable.',
      });
      const body = fanout.send.mock.calls[0][1].notification.body;
      expect(body).toBe('License image unreadable.');
    });
  });
});
