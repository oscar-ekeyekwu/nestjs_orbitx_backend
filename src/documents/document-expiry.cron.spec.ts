/* eslint-disable @typescript-eslint/unbound-method --
 * jest mock introspection is noisy under strict type-checked lint. */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { DocumentExpiryCron } from './document-expiry.cron';
import {
  Document,
  DocumentOwnerType,
  DocumentStatus,
  DocumentType,
} from './entities/document.entity';
import {
  DriverProfile,
  DriverVerificationStatus,
} from '../drivers/entities/driver-profile.entity';
import { Vehicle, VehicleStatus } from '../vehicles/entities/vehicle.entity';
import { Company, CompanyStatus } from '../companies/entities/company.entity';
import { DriversService } from '../drivers/drivers.service';

function buildDoc(overrides: Partial<Document>): Document {
  return {
    id: `doc-${Math.random().toString(36).slice(2)}`,
    ownerType: DocumentOwnerType.USER,
    ownerId: 'user-1',
    type: DocumentType.DRIVERS_LICENSE,
    fileUrl: 'https://example/key.jpg',
    fileKey: 'user/user-1/drivers_license/abc.jpg',
    expiryDate: null,
    status: DocumentStatus.APPROVED,
    uploadedBy: 'user-1',
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Document;
}

function isoDate(d: Date): Date {
  // documents.expiryDate is a `date` column → TypeORM hands back a Date
  // anchored at UTC midnight. Mirror that here.
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, days: number): Date {
  const out = isoDate(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

describe('DocumentExpiryCron (C4)', () => {
  const TODAY = new Date('2026-05-18T10:00:00Z');

  let documentRepo: jest.Mocked<Repository<Document>>;
  let driverProfileRepo: jest.Mocked<Repository<DriverProfile>>;
  let vehicleRepo: jest.Mocked<Repository<Vehicle>>;
  let companyRepo: jest.Mocked<Repository<Company>>;
  let events: jest.Mocked<EventEmitter2>;
  let driversService: {
    transitionVerification: jest.Mock;
  };
  let cron: DocumentExpiryCron;

  beforeEach(() => {
    documentRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn((entity) => Promise.resolve(entity as Document)),
      count: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<Repository<Document>>;

    driverProfileRepo = {
      findOne: jest.fn(),
      save: jest.fn((entity) => Promise.resolve(entity as DriverProfile)),
    } as unknown as jest.Mocked<Repository<DriverProfile>>;

    vehicleRepo = {
      findOne: jest.fn(),
      save: jest.fn((entity) => Promise.resolve(entity as Vehicle)),
    } as unknown as jest.Mocked<Repository<Vehicle>>;

    companyRepo = {
      findOne: jest.fn(),
      save: jest.fn((entity) => Promise.resolve(entity as Company)),
    } as unknown as jest.Mocked<Repository<Company>>;

    events = {
      emit: jest.fn().mockReturnValue(true),
    } as unknown as jest.Mocked<EventEmitter2>;

    // D1: DriversService.transitionVerification is the canonical
    // entry point. The mock mutates the driver profile in-place so
    // existing assertions (savedProfile.isOnline === false, etc.)
    // continue to observe the post-transition state.
    driversService = {
      transitionVerification: jest
        .fn()
        .mockImplementation(
          (driverId: string, dto: { status: DriverVerificationStatus }) => {
            // The cron resolves the profile by userId first, then
            // hands the driverId. We don't need driverId here — the
            // test pre-loads driverProfileRepo.findOne to return a
            // mutable profile object; mutate that.
            const profile = (driverProfileRepo.findOne.mock.results[0]
              ?.value as Promise<DriverProfile | null> | null)
              ? // resolved value cached
                undefined
              : undefined;
            void profile;
            // Drive the save spy so existing assertions on
            // driverProfileRepo.save still observe the call.
            return (async () => {
              const resolved = (await driverProfileRepo.findOne.mock.results[0]
                ?.value) as DriverProfile | null;
              if (!resolved) return null;
              resolved.verificationStatus = dto.status;
              if (
                dto.status === DriverVerificationStatus.SUSPENDED_DOCS_EXPIRED
              ) {
                resolved.isOnline = false;
              }
              await driverProfileRepo.save(resolved);
              return resolved;
            })();
          },
        ),
    };

    cron = new DocumentExpiryCron(
      documentRepo,
      driverProfileRepo,
      vehicleRepo,
      companyRepo,
      events,
      driversService as unknown as DriversService,
    );
  });

  describe('warning windows', () => {
    it('emits document.expiring_soon with daysRemaining=30 on the 30-day boundary', async () => {
      documentRepo.find.mockResolvedValue([
        buildDoc({
          id: 'd-30',
          type: DocumentType.DRIVERS_LICENSE,
          expiryDate: addDays(TODAY, 30),
        }),
      ]);

      const summary = await cron.runSweep(TODAY);

      expect(summary.warned).toBe(1);
      expect(summary.expired).toBe(0);
      expect(events.emit).toHaveBeenCalledWith(
        'document.expiring_soon',
        expect.objectContaining({
          documentId: 'd-30',
          daysRemaining: 30,
        }),
      );
    });

    it('emits document.expiring_soon with daysRemaining=7 on the 7-day boundary', async () => {
      documentRepo.find.mockResolvedValue([
        buildDoc({
          id: 'd-7',
          type: DocumentType.INSURANCE,
          expiryDate: addDays(TODAY, 7),
        }),
      ]);

      await cron.runSweep(TODAY);

      expect(events.emit).toHaveBeenCalledWith(
        'document.expiring_soon',
        expect.objectContaining({
          documentId: 'd-7',
          daysRemaining: 7,
        }),
      );
    });

    it('does NOT emit on non-boundary days (e.g. 15 days out)', async () => {
      documentRepo.find.mockResolvedValue([
        buildDoc({
          id: 'd-15',
          expiryDate: addDays(TODAY, 15),
        }),
      ]);

      const summary = await cron.runSweep(TODAY);

      expect(summary.warned).toBe(0);
      expect(events.emit).not.toHaveBeenCalledWith(
        'document.expiring_soon',
        expect.anything(),
      );
    });
  });

  describe('expiry + driver suspension', () => {
    beforeEach(() => {
      driverProfileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        verificationStatus: DriverVerificationStatus.ACTIVE,
        isOnline: true,
      } as unknown as DriverProfile);
    });

    it('flips the document to expired and suspends the driver via state machine', async () => {
      const expired = buildDoc({
        id: 'd-expired',
        ownerType: DocumentOwnerType.USER,
        ownerId: 'user-1',
        type: DocumentType.DRIVERS_LICENSE,
        expiryDate: addDays(TODAY, -1),
      });
      documentRepo.find.mockResolvedValue([expired]);

      const summary = await cron.runSweep(TODAY);

      expect(summary.expired).toBe(1);
      expect(summary.suspended).toBe(1);

      expect(documentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'd-expired',
          status: DocumentStatus.EXPIRED,
        }),
      );

      const savedProfile = driverProfileRepo.save.mock
        .calls[0][0] as DriverProfile;
      expect(savedProfile.verificationStatus).toBe(
        DriverVerificationStatus.SUSPENDED_DOCS_EXPIRED,
      );
      // Also forces the driver offline so they can't keep working
      // between the suspension flip and the next online check.
      expect(savedProfile.isOnline).toBe(false);

      expect(events.emit).toHaveBeenCalledWith(
        'document.expired',
        expect.objectContaining({ documentId: 'd-expired' }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'owner.suspended_docs_expired',
        expect.objectContaining({
          ownerType: DocumentOwnerType.USER,
          ownerId: 'user-1',
        }),
      );
    });

    it('does NOT suspend when document type is non-trigger (e.g. nin)', async () => {
      // NIN doesn't have expiry per real-world data, but the sweep
      // should never crash on an unexpected expired type. The
      // SUSPENSION_TRIGGER_DOC_TYPES allowlist gates it.
      documentRepo.find.mockResolvedValue([
        buildDoc({
          type: DocumentType.NIN,
          expiryDate: addDays(TODAY, -1),
        }),
      ]);

      const summary = await cron.runSweep(TODAY);

      expect(summary.expired).toBe(1);
      expect(summary.suspended).toBe(0);
      expect(driverProfileRepo.save).not.toHaveBeenCalled();
    });

    it('no-op when driver is already suspended (state machine forbids ACTIVE→x from non-ACTIVE)', async () => {
      driverProfileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        verificationStatus: DriverVerificationStatus.SUSPENDED_DOCS_EXPIRED,
        isOnline: false,
      } as unknown as DriverProfile);

      documentRepo.find.mockResolvedValue([
        buildDoc({
          type: DocumentType.DRIVERS_LICENSE,
          expiryDate: addDays(TODAY, -2),
        }),
      ]);

      const summary = await cron.runSweep(TODAY);

      expect(summary.expired).toBe(1);
      expect(summary.suspended).toBe(0);
      expect(driverProfileRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('vehicle suspension', () => {
    it('expired insurance on an active vehicle flips status to suspended', async () => {
      vehicleRepo.findOne.mockResolvedValue({
        id: 'v-1',
        status: VehicleStatus.ACTIVE,
      } as unknown as Vehicle);
      documentRepo.find.mockResolvedValue([
        buildDoc({
          ownerType: DocumentOwnerType.VEHICLE,
          ownerId: 'v-1',
          type: DocumentType.INSURANCE,
          expiryDate: addDays(TODAY, -1),
        }),
      ]);

      const summary = await cron.runSweep(TODAY);

      expect(summary.suspended).toBe(1);
      const saved = vehicleRepo.save.mock.calls[0][0] as Vehicle;
      expect(saved.status).toBe(VehicleStatus.SUSPENDED);
    });

    it('no-op when vehicle is not in ACTIVE (e.g. DRAFT)', async () => {
      vehicleRepo.findOne.mockResolvedValue({
        id: 'v-1',
        status: VehicleStatus.DRAFT,
      } as unknown as Vehicle);
      documentRepo.find.mockResolvedValue([
        buildDoc({
          ownerType: DocumentOwnerType.VEHICLE,
          ownerId: 'v-1',
          type: DocumentType.INSURANCE,
          expiryDate: addDays(TODAY, -1),
        }),
      ]);

      const summary = await cron.runSweep(TODAY);

      expect(summary.suspended).toBe(0);
      expect(vehicleRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('company suspension', () => {
    it('expired CAC on an approved company flips status to suspended', async () => {
      companyRepo.findOne.mockResolvedValue({
        id: 'c-1',
        status: CompanyStatus.APPROVED,
      } as unknown as Company);
      documentRepo.find.mockResolvedValue([
        buildDoc({
          ownerType: DocumentOwnerType.COMPANY,
          ownerId: 'c-1',
          type: DocumentType.CAC_CERTIFICATE,
          expiryDate: addDays(TODAY, -1),
        }),
      ]);

      const summary = await cron.runSweep(TODAY);

      expect(summary.suspended).toBe(1);
      const saved = companyRepo.save.mock.calls[0][0] as Company;
      expect(saved.status).toBe(CompanyStatus.SUSPENDED);
    });
  });

  describe('recoverOwnerIfDocsClear (C5 hook)', () => {
    it('returns false when other expired docs remain — leaves owner suspended', async () => {
      documentRepo.count.mockResolvedValue(1);

      const recovered = await cron.recoverOwnerIfDocsClear(
        DocumentOwnerType.USER,
        'user-1',
      );

      expect(recovered).toBe(false);
      expect(driverProfileRepo.save).not.toHaveBeenCalled();
    });

    it('reactivates a suspended driver when no expired docs remain', async () => {
      documentRepo.count.mockResolvedValue(0);
      driverProfileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        verificationStatus: DriverVerificationStatus.SUSPENDED_DOCS_EXPIRED,
      } as unknown as DriverProfile);

      const recovered = await cron.recoverOwnerIfDocsClear(
        DocumentOwnerType.USER,
        'user-1',
      );

      expect(recovered).toBe(true);
      const saved = driverProfileRepo.save.mock.calls[0][0] as DriverProfile;
      expect(saved.verificationStatus).toBe(DriverVerificationStatus.ACTIVE);
    });

    it('reactivates a suspended vehicle when no expired docs remain', async () => {
      documentRepo.count.mockResolvedValue(0);
      vehicleRepo.findOne.mockResolvedValue({
        id: 'v-1',
        status: VehicleStatus.SUSPENDED,
      } as unknown as Vehicle);

      const recovered = await cron.recoverOwnerIfDocsClear(
        DocumentOwnerType.VEHICLE,
        'v-1',
      );

      expect(recovered).toBe(true);
      const saved = vehicleRepo.save.mock.calls[0][0] as Vehicle;
      expect(saved.status).toBe(VehicleStatus.ACTIVE);
    });

    it('reactivates a suspended company when no expired docs remain', async () => {
      documentRepo.count.mockResolvedValue(0);
      companyRepo.findOne.mockResolvedValue({
        id: 'c-1',
        status: CompanyStatus.SUSPENDED,
      } as unknown as Company);

      const recovered = await cron.recoverOwnerIfDocsClear(
        DocumentOwnerType.COMPANY,
        'c-1',
      );

      expect(recovered).toBe(true);
      const saved = companyRepo.save.mock.calls[0][0] as Company;
      expect(saved.status).toBe(CompanyStatus.APPROVED);
    });

    it('no-op when the owner is not currently suspended (idempotent)', async () => {
      documentRepo.count.mockResolvedValue(0);
      driverProfileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        verificationStatus: DriverVerificationStatus.ACTIVE,
      } as unknown as DriverProfile);

      const recovered = await cron.recoverOwnerIfDocsClear(
        DocumentOwnerType.USER,
        'user-1',
      );

      expect(recovered).toBe(false);
      expect(driverProfileRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('mixed batch', () => {
    it('combines warning + expiry + suspension in a single sweep', async () => {
      driverProfileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        verificationStatus: DriverVerificationStatus.ACTIVE,
        isOnline: true,
      } as unknown as DriverProfile);

      documentRepo.find.mockResolvedValue([
        buildDoc({
          id: 'd-30',
          type: DocumentType.LASAA_PERMIT,
          expiryDate: addDays(TODAY, 30),
          ownerType: DocumentOwnerType.VEHICLE,
          ownerId: 'v-1',
        }),
        buildDoc({
          id: 'd-7',
          type: DocumentType.INSURANCE,
          expiryDate: addDays(TODAY, 7),
          ownerType: DocumentOwnerType.VEHICLE,
          ownerId: 'v-2',
        }),
        buildDoc({
          id: 'd-old',
          type: DocumentType.DRIVERS_LICENSE,
          expiryDate: addDays(TODAY, -3),
          ownerType: DocumentOwnerType.USER,
          ownerId: 'user-1',
        }),
        buildDoc({
          id: 'd-noisy',
          expiryDate: addDays(TODAY, 12), // not on a boundary
        }),
      ]);

      const summary = await cron.runSweep(TODAY);

      expect(summary.warned).toBe(2);
      expect(summary.expired).toBe(1);
      expect(summary.suspended).toBe(1);
    });
  });
});
