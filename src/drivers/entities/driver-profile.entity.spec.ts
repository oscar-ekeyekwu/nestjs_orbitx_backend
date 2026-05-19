import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import {
  DriverAccountType,
  DriverVerificationStatus,
  DriverProfile,
} from './driver-profile.entity';

/**
 * B2 — entity-level guarantees on the enum + relation shape.
 *
 * The migration's enum types and the entity enums must agree on the
 * exact string values, in order. A mismatch silently breaks INSERT
 * and SELECT shape detection in TypeORM. Asserting on the enum
 * literals here means a typo or accidental reorder is a failing test,
 * not a production-runtime error.
 */
describe('DriverProfile entity (B2)', () => {
  describe('DriverAccountType enum values', () => {
    it('matches the migration enum public.driver_profiles_accounttype_enum', () => {
      expect(Object.values(DriverAccountType)).toEqual([
        'individual',
        'company_owner',
        'company_employee',
      ]);
    });
  });

  describe('DriverVerificationStatus enum values', () => {
    it('matches the migration enum public.driver_profiles_verificationstatus_enum', () => {
      expect(Object.values(DriverVerificationStatus)).toEqual([
        'setup_required',
        'pending_approval',
        'approved',
        'active',
        'rejected',
        'suspended_docs_expired',
        'suspended_admin',
      ]);
    });
  });

  describe('TypeORM column + relation metadata', () => {
    const storage = getMetadataArgsStorage();

    function columnFor(
      propertyName: keyof DriverProfile,
    ): ReturnType<typeof storage.filterColumns>[number] | undefined {
      return storage
        .filterColumns(DriverProfile)
        .find((c) => c.propertyName === propertyName);
    }

    it('accountType defaults to individual', () => {
      const col = columnFor('accountType');
      expect(col?.options.default).toBe(DriverAccountType.INDIVIDUAL);
    });

    it('verificationStatus defaults to setup_required', () => {
      const col = columnFor('verificationStatus');
      expect(col?.options.default).toBe(
        DriverVerificationStatus.SETUP_REQUIRED,
      );
    });

    it('companyId is a nullable uuid column', () => {
      const col = columnFor('companyId');
      expect(col?.options.type).toBe('uuid');
      expect(col?.options.nullable).toBe(true);
    });

    it('company relation is a nullable ManyToOne -> Company', () => {
      const relation = storage
        .filterRelations(DriverProfile)
        .find((r) => r.propertyName === 'company');
      expect(relation).toBeDefined();
      expect(relation?.relationType).toBe('many-to-one');
      expect(relation?.options.nullable).toBe(true);
    });

    it('inline vehicle columns have been removed (B2 schema split)', () => {
      // vehicleType / vehiclePlate / licenseNumber live in `vehicles`
      // and `documents` now. A stray re-introduction here would mean
      // the schema-split refactor regressed.
      expect(columnFor('vehicleType' as keyof DriverProfile)).toBeUndefined();
      expect(columnFor('vehiclePlate' as keyof DriverProfile)).toBeUndefined();
      expect(columnFor('licenseNumber' as keyof DriverProfile)).toBeUndefined();
    });
  });
});
