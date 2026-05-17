import { BadRequestException } from '@nestjs/common';
import { vehicleStateMachine } from './vehicle-state-machine';
import { VehicleStatus } from './entities/vehicle.entity';

const V = VehicleStatus;

describe('vehicleStateMachine', () => {
  describe('declared transitions (positive cases)', () => {
    const legal: Array<[VehicleStatus, VehicleStatus]> = [
      [V.DRAFT, V.PENDING_APPROVAL],
      [V.PENDING_APPROVAL, V.APPROVED],
      [V.PENDING_APPROVAL, V.REJECTED],
      [V.REJECTED, V.PENDING_APPROVAL],
      [V.APPROVED, V.ACTIVE],
      [V.ACTIVE, V.SUSPENDED],
      [V.SUSPENDED, V.ACTIVE],
      [V.APPROVED, V.RETIRED],
      [V.ACTIVE, V.RETIRED],
      [V.SUSPENDED, V.RETIRED],
    ];

    it.each(legal)('%s → %s is allowed', (from, to) => {
      expect(vehicleStateMachine.canTransition(from, to)).toBe(true);
      expect(() =>
        vehicleStateMachine.assertTransition(from, to, 'VEHICLE_001'),
      ).not.toThrow();
    });
  });

  describe('illegal transitions (negative cases)', () => {
    const illegal: Array<[VehicleStatus, VehicleStatus]> = [
      // Cannot skip review.
      [V.DRAFT, V.ACTIVE],
      [V.DRAFT, V.APPROVED],
      // Retired is terminal — add a fresh vehicle row instead of reviving.
      [V.RETIRED, V.ACTIVE],
      [V.RETIRED, V.PENDING_APPROVAL],
      // Active vehicles cannot be pushed back to draft / pending.
      [V.ACTIVE, V.DRAFT],
      [V.ACTIVE, V.PENDING_APPROVAL],
      // Suspended must recover via "active" first; cannot rebrand as draft.
      [V.SUSPENDED, V.DRAFT],
      // No self-loops.
      [V.APPROVED, V.APPROVED],
    ];

    it.each(illegal)('%s → %s is rejected', (from, to) => {
      expect(vehicleStateMachine.canTransition(from, to)).toBe(false);
      expect(() =>
        vehicleStateMachine.assertTransition(from, to, 'VEHICLE_001'),
      ).toThrow(BadRequestException);
    });
  });

  describe('role metadata', () => {
    it('tags admin-mediated approval / suspension correctly', () => {
      expect(
        vehicleStateMachine.getTransition(V.PENDING_APPROVAL, V.APPROVED)
          ?.requiredRole,
      ).toBe('admin');
      expect(
        vehicleStateMachine.getTransition(V.ACTIVE, V.SUSPENDED)?.requiredRole,
      ).toBe('admin');
      expect(
        vehicleStateMachine.getTransition(V.SUSPENDED, V.ACTIVE)?.requiredRole,
      ).toBe('admin');
    });
  });
});
