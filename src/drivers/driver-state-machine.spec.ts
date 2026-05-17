import { BadRequestException } from '@nestjs/common';
import { driverStateMachine } from './driver-state-machine';
import { DriverVerificationStatus } from './entities/driver-profile.entity';

const S = DriverVerificationStatus;

describe('driverStateMachine', () => {
  describe('declared transitions (positive cases)', () => {
    const legal: Array<[DriverVerificationStatus, DriverVerificationStatus]> = [
      [S.SETUP_REQUIRED, S.PENDING_APPROVAL],
      [S.PENDING_APPROVAL, S.APPROVED],
      [S.PENDING_APPROVAL, S.REJECTED],
      [S.REJECTED, S.PENDING_APPROVAL],
      [S.APPROVED, S.ACTIVE],
      [S.ACTIVE, S.SUSPENDED_DOCS_EXPIRED],
      [S.ACTIVE, S.SUSPENDED_ADMIN],
      [S.SUSPENDED_DOCS_EXPIRED, S.ACTIVE],
      [S.SUSPENDED_ADMIN, S.PENDING_APPROVAL],
    ];

    it.each(legal)('%s → %s is allowed', (from, to) => {
      expect(driverStateMachine.canTransition(from, to)).toBe(true);
      expect(() =>
        driverStateMachine.assertTransition(from, to, 'DRIVER_002'),
      ).not.toThrow();
    });
  });

  describe('illegal transitions (negative cases)', () => {
    const illegal: Array<[DriverVerificationStatus, DriverVerificationStatus]> =
      [
        // Cannot skip approval flow.
        [S.SETUP_REQUIRED, S.ACTIVE],
        [S.SETUP_REQUIRED, S.APPROVED],
        // Active drivers cannot be sent back to pending without admin
        // suspending first.
        [S.ACTIVE, S.PENDING_APPROVAL],
        [S.ACTIVE, S.SETUP_REQUIRED],
        // Suspended-docs-expired must recover to active (not directly to
        // pending_approval). Document refresh re-activates.
        [S.SUSPENDED_DOCS_EXPIRED, S.PENDING_APPROVAL],
        // Approved cannot regress to pending without a rejection or
        // suspension in between.
        [S.APPROVED, S.PENDING_APPROVAL],
        // No self-loops.
        [S.ACTIVE, S.ACTIVE],
      ];

    it.each(illegal)('%s → %s is rejected', (from, to) => {
      expect(driverStateMachine.canTransition(from, to)).toBe(false);
      expect(() =>
        driverStateMachine.assertTransition(from, to, 'DRIVER_002'),
      ).toThrow(BadRequestException);
    });
  });

  describe('role metadata', () => {
    it('tags admin-only transitions correctly', () => {
      expect(
        driverStateMachine.getTransition(S.PENDING_APPROVAL, S.APPROVED)
          ?.requiredRole,
      ).toBe('admin');
      expect(
        driverStateMachine.getTransition(S.PENDING_APPROVAL, S.REJECTED)
          ?.requiredRole,
      ).toBe('admin');
      expect(
        driverStateMachine.getTransition(S.ACTIVE, S.SUSPENDED_ADMIN)
          ?.requiredRole,
      ).toBe('admin');
    });

    it('tags the system-driven docs-expired suspension', () => {
      expect(
        driverStateMachine.getTransition(S.ACTIVE, S.SUSPENDED_DOCS_EXPIRED)
          ?.requiredRole,
      ).toBe('system');
    });

    it('leaves user-driven setup → pending and re-submission open (no requiredRole)', () => {
      expect(
        driverStateMachine.getTransition(S.SETUP_REQUIRED, S.PENDING_APPROVAL)
          ?.requiredRole,
      ).toBeUndefined();
      expect(
        driverStateMachine.getTransition(S.REJECTED, S.PENDING_APPROVAL)
          ?.requiredRole,
      ).toBeUndefined();
    });
  });
});
