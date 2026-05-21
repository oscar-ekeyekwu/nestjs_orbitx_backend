/* eslint-disable @typescript-eslint/unbound-method --
 * jest mock introspection is noisy under strict type-checked lint. */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { DocumentsService } from './documents.service';
import {
  Document,
  DocumentOwnerType,
  DocumentType,
  DocumentStatus,
} from './entities/document.entity';
import type { PresignedUpload } from '../storage/storage-adapter.interface';
import type { StorageAdapter } from '../storage/storage-adapter.interface';
import { StorageRegistry } from '../storage/storage-registry.service';
import * as polymorphic from '../common/polymorphic';
import { DocumentExpiryCron } from './document-expiry.cron';
import { ApprovalsService } from '../approvals/approvals.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ErrorCodes } from '../common/constants/error-codes';
import { UserRole } from '../common/enums/user-role.enum';
import type { User } from '../users/entities/user.entity';

const ADMIN: User = {
  id: 'admin-1',
  email: 'admin@orbitx.com',
  role: UserRole.ADMIN,
} as unknown as User;

const DRIVER: User = {
  id: 'user-1',
  email: 'tunde@example.com',
  role: UserRole.DRIVER,
} as unknown as User;

const OTHER_DRIVER: User = {
  id: 'user-2',
  email: 'other@example.com',
  role: UserRole.DRIVER,
} as unknown as User;

function buildDocument(overrides: Partial<Document>): Document {
  return {
    id: 'doc-1',
    ownerType: DocumentOwnerType.USER,
    ownerId: 'user-1',
    type: DocumentType.DRIVERS_LICENSE,
    fileUrl:
      'https://nyc3.digitaloceanspaces.com/orbit-kyc-v1/user/user-1/drivers_license/abc.jpg',
    fileKey: 'user/user-1/drivers_license/abc.jpg',
    storageProviderId: 'provider-1',
    expiryDate: null,
    status: DocumentStatus.PENDING,
    uploadedBy: 'user-1',
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Document;
}

function extractErrorCode(err: unknown): string | undefined {
  if (!(err instanceof BadRequestException)) return undefined;
  const response = err.getResponse();
  if (
    typeof response === 'object' &&
    response !== null &&
    'errorCode' in response
  ) {
    return (response as { errorCode: string }).errorCode;
  }
  return undefined;
}

describe('DocumentsService (ARCH-9 + C1 + C2)', () => {
  let service: DocumentsService;
  let documentRepo: jest.Mocked<Repository<Document>>;
  let vehicleRepo: { findOne: jest.Mock };
  let assignmentRepo: { findOne: jest.Mock };
  let companyRepo: { findOne: jest.Mock };
  let driverProfileRepo: { findOne: jest.Mock };
  let adapter: jest.Mocked<StorageAdapter>;
  let storageRegistry: jest.Mocked<StorageRegistry>;
  let dataSource: jest.Mocked<DataSource>;
  let expiryCron: jest.Mocked<DocumentExpiryCron>;
  let loadOwnerSpy: jest.SpyInstance;

  beforeEach(() => {
    documentRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((entity) => entity as Document),
      save: jest.fn((entity: Document) =>
        Promise.resolve({ ...entity, id: 'doc-new' }),
      ),
    } as unknown as jest.Mocked<Repository<Document>>;

    // Default ownership: the lookup returns a vehicle owned by
    // 'someone-else', so vehicle / company tests that don't set up a
    // specific relationship deny the caller — preserving the
    // "non-admin cannot touch other-owner docs" intent of the
    // pre-D2/D3/D4 placeholder.
    vehicleRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'vehicle-1',
        ownerType: 'individual_driver',
        ownerId: 'profile-someone-else',
      }),
    };
    assignmentRepo = { findOne: jest.fn().mockResolvedValue(null) };
    companyRepo = { findOne: jest.fn().mockResolvedValue(null) };
    // Default: no driver_profile matches the caller, so vehicle docs
    // owned by "profile-someone-else" stay forbidden.
    driverProfileRepo = { findOne: jest.fn().mockResolvedValue(null) };

    adapter = {
      providerId: 'provider-1',
      providerSlug: 'spaces-default',
      bucket: 'orbit-kyc-v1',
      generateUploadUrl: jest.fn(),
      generateViewUrl: jest.fn(),
      uploadBuffer: jest.fn(),
      objectExists: jest.fn().mockResolvedValue(true),
      getStream: jest.fn(),
      delete: jest.fn(),
      canonicalUri: jest.fn(
        (key: string) =>
          `https://nyc3.digitaloceanspaces.com/orbit-kyc-v1/${key}`,
      ),
    } as unknown as jest.Mocked<StorageAdapter>;
    storageRegistry = {
      getActive: jest.fn().mockResolvedValue(adapter),
      get: jest.fn().mockResolvedValue(adapter),
    } as unknown as jest.Mocked<StorageRegistry>;

    dataSource = {
      manager: {} as unknown,
      transaction: jest.fn((cb: (m: unknown) => unknown) =>
        Promise.resolve(cb({})),
      ) as unknown,
    } as unknown as jest.Mocked<DataSource>;

    // Default: owner lookup resolves to a non-null sentinel so C2's
    // DOCUMENT_002 path doesn't fire unless a test opts in.
    loadOwnerSpy = jest
      .spyOn(polymorphic, 'loadOwner')
      .mockResolvedValue({ id: 'owner-1' } as unknown as never);

    expiryCron = {
      recoverOwnerIfDocsClear: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<DocumentExpiryCron>;

    // C6: shared audit-ledger service. The recordDecision implementation
    // is a passthrough to manager.insert so the existing transactional
    // setupTransactionalDoc fixtures keep observing the same call shape.
    const approvalsService = {
      recordDecision: jest.fn(
        async (manager: { insert: jest.Mock }, input: unknown) => {
          await manager.insert('approval_decisions', input);
        },
      ),
    } as unknown as ApprovalsService;

    // ARCH-10: EventEmitter2 dep — reviewDocument emits
    // document.approved / document.rejected after commit.
    const events = {
      emit: jest.fn().mockReturnValue(true),
    } as unknown as EventEmitter2;

    service = new DocumentsService(
      documentRepo,
      vehicleRepo as never,
      assignmentRepo as never,
      companyRepo as never,
      driverProfileRepo as never,
      storageRegistry,
      dataSource,
      expiryCron,
      approvalsService,
      events,
    );
  });

  afterEach(() => {
    loadOwnerSpy.mockRestore();
  });

  describe('generateUploadUrl', () => {
    const dto = {
      ownerType: DocumentOwnerType.USER,
      ownerId: 'user-1',
      docType: DocumentType.DRIVERS_LICENSE,
      contentType: 'image/jpeg',
    };

    it('owner matches: returns presigned upload', async () => {
      const presigned: PresignedUpload = {
        uploadUrl: 'https://signed.example/put',
        objectKey: 'user/user-1/drivers_license/uuid.jpg',
      };
      adapter.generateUploadUrl.mockResolvedValue(presigned);

      const result = await service.generateUploadUrl(dto, DRIVER);

      expect(result).toBe(presigned);
      expect(adapter.generateUploadUrl).toHaveBeenCalledWith(dto);
    });

    it('admin bypasses the owner check', async () => {
      const presigned: PresignedUpload = {
        uploadUrl: 'https://signed.example/put',
        objectKey: 'user/user-1/drivers_license/uuid.jpg',
      };
      adapter.generateUploadUrl.mockResolvedValue(presigned);

      const result = await service.generateUploadUrl(dto, ADMIN);

      expect(result).toBe(presigned);
    });

    it('rejects non-admin trying to upload for another user (403)', async () => {
      await expect(
        service.generateUploadUrl(dto, OTHER_DRIVER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(adapter.generateUploadUrl).not.toHaveBeenCalled();
    });

    it('rejects non-admin uploading vehicle docs', async () => {
      await expect(
        service.generateUploadUrl(
          {
            ownerType: DocumentOwnerType.VEHICLE,
            ownerId: 'vehicle-1',
            docType: DocumentType.VEHICLE_REGISTRATION,
            contentType: 'application/pdf',
          },
          DRIVER,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin can upload vehicle docs', async () => {
      const presigned: PresignedUpload = {
        uploadUrl: 'https://signed.example/put',
        objectKey: 'vehicle/vehicle-1/vehicle_registration/uuid.pdf',
      };
      adapter.generateUploadUrl.mockResolvedValue(presigned);

      const result = await service.generateUploadUrl(
        {
          ownerType: DocumentOwnerType.VEHICLE,
          ownerId: 'vehicle-1',
          docType: DocumentType.VEHICLE_REGISTRATION,
          contentType: 'application/pdf',
        },
        ADMIN,
      );

      expect(result).toBe(presigned);
    });

    // C1 — MIME allowlist enforcement
    it.each([
      ['image/gif'],
      ['application/msword'],
      ['text/html'],
      ['application/octet-stream'],
      [''],
    ])('FILE_001 — rejects non-allowlist contentType "%s"', async (badType) => {
      const badDto = { ...dto, contentType: badType };
      let caught: unknown;
      try {
        await service.generateUploadUrl(badDto, DRIVER);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(extractErrorCode(caught)).toBe(ErrorCodes.FILE_001);
      expect(adapter.generateUploadUrl).not.toHaveBeenCalled();
    });

    it.each([['image/jpeg'], ['image/png'], ['application/pdf']])(
      'allows allowlist contentType "%s"',
      async (mime) => {
        adapter.generateUploadUrl.mockResolvedValue({
          uploadUrl: 'u',
          objectKey: 'k',
        });
        await expect(
          service.generateUploadUrl({ ...dto, contentType: mime }, DRIVER),
        ).resolves.toBeDefined();
      },
    );
  });

  describe('createDocument (C1 + C2)', () => {
    const dto = {
      ownerType: DocumentOwnerType.USER,
      ownerId: 'user-1',
      docType: DocumentType.NIN,
      fileKey: 'user/user-1/nin/abc.jpg',
    };

    it('persists row when HEAD confirms object exists', async () => {
      const saved = await service.createDocument(dto, DRIVER);

      expect(adapter.objectExists).toHaveBeenCalledWith(dto.fileKey);
      expect(documentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerType: DocumentOwnerType.USER,
          ownerId: 'user-1',
          type: DocumentType.NIN,
          fileKey: dto.fileKey,
          storageProviderId: 'provider-1',
          status: DocumentStatus.PENDING,
          uploadedBy: 'user-1',
          reviewedAt: null,
          reviewedBy: null,
          rejectionReason: null,
        }),
      );
      expect(saved.id).toBe('doc-new');
    });

    it('seeds fileUrl from adapter.canonicalUri(objectKey)', async () => {
      await service.createDocument(dto, DRIVER);
      expect(adapter.canonicalUri).toHaveBeenCalledWith(dto.fileKey);
      expect(documentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          fileUrl: `https://nyc3.digitaloceanspaces.com/orbit-kyc-v1/${dto.fileKey}`,
        }),
      );
    });

    it('parses expiryDate string to Date when supplied', async () => {
      await service.createDocument(
        {
          ...dto,
          docType: DocumentType.DRIVERS_LICENSE,
          fileKey: 'user/user-1/drivers_license/abc.jpg',
          expiryDate: '2027-03-15',
        },
        DRIVER,
      );
      const created = documentRepo.create.mock.calls[0][0] as {
        expiryDate: Date | null;
      };
      expect(created.expiryDate).toBeInstanceOf(Date);
      expect((created.expiryDate as Date).toISOString()).toMatch(/^2027-03-15/);
    });

    it('FILE_002 — HEAD returns false → 400 with errorCode FILE_002', async () => {
      adapter.objectExists.mockResolvedValue(false);

      let caught: unknown;
      try {
        await service.createDocument(dto, DRIVER);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(extractErrorCode(caught)).toBe(ErrorCodes.FILE_002);
      expect(documentRepo.save).not.toHaveBeenCalled();
    });

    it('FILE_002 — rejects objectKey whose prefix does not match owner/docType', async () => {
      const badKey = 'user/SOMEONE-ELSE/nin/abc.jpg';
      let caught: unknown;
      try {
        await service.createDocument({ ...dto, fileKey: badKey }, DRIVER);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(extractErrorCode(caught)).toBe(ErrorCodes.FILE_002);
      expect(adapter.objectExists).not.toHaveBeenCalled();
    });

    it('rejects non-admin trying to persist for another user (403)', async () => {
      await expect(
        service.createDocument(dto, OTHER_DRIVER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(adapter.objectExists).not.toHaveBeenCalled();
    });

    it('admin can persist for any owner', async () => {
      await expect(
        service.createDocument(
          {
            ...dto,
            ownerId: 'someone-else',
            fileKey: 'user/someone-else/nin/x.jpg',
          },
          ADMIN,
        ),
      ).resolves.toBeDefined();
    });

    it('non-admin cannot persist vehicle docs', async () => {
      await expect(
        service.createDocument(
          {
            ownerType: DocumentOwnerType.VEHICLE,
            ownerId: 'vehicle-1',
            docType: DocumentType.VEHICLE_REGISTRATION,
            fileKey: 'vehicle/vehicle-1/vehicle_registration/x.pdf',
          },
          DRIVER,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    // C2 — expiry-required validation
    it.each([
      DocumentType.DRIVERS_LICENSE,
      DocumentType.INSURANCE,
      DocumentType.ROADWORTHY,
      DocumentType.LASAA_PERMIT,
      DocumentType.NIPOST_LICENSE,
    ])('DOCUMENT_001 — rejects %s without expiryDate', async (docType) => {
      const badDto = {
        ownerType: DocumentOwnerType.USER,
        ownerId: 'user-1',
        docType,
        fileKey: `user/user-1/${docType}/abc.jpg`,
      };
      let caught: unknown;
      try {
        await service.createDocument(badDto, DRIVER);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(extractErrorCode(caught)).toBe(ErrorCodes.DOCUMENT_001);
      expect(adapter.objectExists).not.toHaveBeenCalled();
    });

    it.each([
      DocumentType.NIN,
      DocumentType.CAC_CERTIFICATE,
      DocumentType.SELFIE,
    ])('allows non-expiring %s without expiryDate', async (docType) => {
      await expect(
        service.createDocument(
          {
            ownerType: DocumentOwnerType.USER,
            ownerId: 'user-1',
            docType,
            fileKey: `user/user-1/${docType}/abc.jpg`,
          },
          DRIVER,
        ),
      ).resolves.toBeDefined();
    });

    // C2 — polymorphic owner validation
    it('DOCUMENT_002 — rejects when ownerId does not resolve to a row', async () => {
      loadOwnerSpy.mockResolvedValueOnce(null);

      let caught: unknown;
      try {
        await service.createDocument(dto, DRIVER);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(extractErrorCode(caught)).toBe(ErrorCodes.DOCUMENT_002);
      expect(adapter.objectExists).not.toHaveBeenCalled();
    });

    // C2 — multi-version doc history: re-upload doesn't touch the prior row
    it('re-uploading an approved docType creates a new pending row (no UPDATE of prior)', async () => {
      const dto2 = {
        ...dto,
        fileKey: 'user/user-1/nin/second-upload.jpg',
      };
      await service.createDocument(dto, DRIVER);
      await service.createDocument(dto2, DRIVER);

      // save() called twice, both create() calls produced status=pending
      expect(documentRepo.save).toHaveBeenCalledTimes(2);
      const createdRows = documentRepo.create.mock.calls.map(
        ([entity]) => entity as { status: DocumentStatus },
      );
      expect(
        createdRows.every((row) => row.status === DocumentStatus.PENDING),
      ).toBe(true);
    });
  });

  describe('listDocuments (C2)', () => {
    it('admin: applies all caller-supplied filters', async () => {
      const filters = {
        ownerType: DocumentOwnerType.USER,
        ownerId: 'user-1',
        type: DocumentType.NIN,
        status: DocumentStatus.APPROVED,
      };
      await service.listDocuments(filters, ADMIN);

      expect(documentRepo.find).toHaveBeenCalledWith({
        where: {
          ownerType: DocumentOwnerType.USER,
          ownerId: 'user-1',
          type: DocumentType.NIN,
          status: DocumentStatus.APPROVED,
        },
        order: { createdAt: 'DESC' },
      });
    });

    it('admin: works with no filters (returns everything ordered desc)', async () => {
      await service.listDocuments({}, ADMIN);
      expect(documentRepo.find).toHaveBeenCalledWith({
        where: {},
        order: { createdAt: 'DESC' },
      });
    });

    it('non-admin: caller-supplied ownerId is ignored and forced to caller.id', async () => {
      // Driver tries to list someone else's docs
      await service.listDocuments(
        {
          ownerType: DocumentOwnerType.USER,
          ownerId: 'someone-else',
        },
        DRIVER,
      );
      const callArg = documentRepo.find.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(callArg.where.ownerId).toBe(DRIVER.id);
      expect(callArg.where.ownerType).toBe(DocumentOwnerType.USER);
    });

    it('non-admin: caller-supplied ownerType=vehicle is ignored and coerced to user', async () => {
      await service.listDocuments(
        { ownerType: DocumentOwnerType.VEHICLE },
        DRIVER,
      );
      const callArg = documentRepo.find.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(callArg.where.ownerType).toBe(DocumentOwnerType.USER);
      expect(callArg.where.ownerId).toBe(DRIVER.id);
    });
  });

  describe('findOne (C2)', () => {
    it('owner sees their own document', async () => {
      documentRepo.findOne.mockResolvedValue(
        buildDocument({ ownerId: DRIVER.id }),
      );
      const result = await service.findOne('doc-1', DRIVER);
      expect(result.ownerId).toBe(DRIVER.id);
    });

    it('admin sees any document', async () => {
      documentRepo.findOne.mockResolvedValue(
        buildDocument({ ownerId: 'someone-else' }),
      );
      await expect(service.findOne('doc-1', ADMIN)).resolves.toBeDefined();
    });

    it('rejects non-owner non-admin (403)', async () => {
      documentRepo.findOne.mockResolvedValue(
        buildDocument({ ownerId: 'user-1' }),
      );
      await expect(
        service.findOne('doc-1', OTHER_DRIVER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404 when document does not exist', async () => {
      documentRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne('missing', ADMIN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('reviewDocument (C5)', () => {
    function setupTransactionalDoc(doc: Partial<Document>): Document {
      const built = {
        ...buildDocument(doc),
        status: doc.status ?? DocumentStatus.PENDING,
      } as Document;
      const manager = {
        findOne: jest.fn().mockResolvedValue(built),
        save: jest.fn((entity: Document) => Promise.resolve(entity)),
        insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'ap-1' }] }),
      };
      (dataSource.transaction as unknown as jest.Mock).mockImplementation(
        (cb: (m: typeof manager) => unknown) => cb(manager),
      );
      return built;
    }

    it('approves a pending doc and fires the C4 recovery hook', async () => {
      setupTransactionalDoc({
        id: 'doc-1',
        ownerType: DocumentOwnerType.USER,
        ownerId: 'user-1',
        status: DocumentStatus.PENDING,
      });

      const result = await service.reviewDocument(
        'doc-1',
        { status: DocumentStatus.APPROVED, reason: 'looks good' },
        ADMIN,
      );

      expect(result.status).toBe(DocumentStatus.APPROVED);
      expect(result.reviewedBy).toBe(ADMIN.id);
      expect(result.reviewedAt).toBeInstanceOf(Date);
      expect(expiryCron.recoverOwnerIfDocsClear).toHaveBeenCalledWith(
        DocumentOwnerType.USER,
        'user-1',
      );
    });

    it('rejects with a reason, persists rejectionReason, does NOT fire recovery hook', async () => {
      setupTransactionalDoc({
        id: 'doc-1',
        status: DocumentStatus.PENDING,
      });

      const result = await service.reviewDocument(
        'doc-1',
        {
          status: DocumentStatus.REJECTED,
          reason: 'Photo is blurry; please re-take.',
        },
        ADMIN,
      );

      expect(result.status).toBe(DocumentStatus.REJECTED);
      expect(result.rejectionReason).toBe('Photo is blurry; please re-take.');
      expect(expiryCron.recoverOwnerIfDocsClear).not.toHaveBeenCalled();
    });

    it('rejects without reason → 400 VAL_003', async () => {
      let caught: unknown;
      try {
        await service.reviewDocument(
          'doc-1',
          { status: DocumentStatus.REJECTED },
          ADMIN,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(extractErrorCode(caught)).toBe(ErrorCodes.VAL_003);
    });

    it('only approved/rejected are allowed (expired is cron-owned) → 400 VAL_002', async () => {
      let caught: unknown;
      try {
        await service.reviewDocument(
          'doc-1',
          { status: DocumentStatus.EXPIRED } as unknown as {
            status: DocumentStatus;
          },
          ADMIN,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(extractErrorCode(caught)).toBe(ErrorCodes.VAL_002);
    });

    it('refuses to re-review a non-pending document', async () => {
      setupTransactionalDoc({
        id: 'doc-1',
        status: DocumentStatus.APPROVED,
      });

      let caught: unknown;
      try {
        await service.reviewDocument(
          'doc-1',
          { status: DocumentStatus.REJECTED, reason: 'no' },
          ADMIN,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(extractErrorCode(caught)).toBe(ErrorCodes.VAL_002);
    });

    it('recovery hook failure does not roll back the approval', async () => {
      setupTransactionalDoc({
        id: 'doc-1',
        ownerType: DocumentOwnerType.USER,
        ownerId: 'user-1',
        status: DocumentStatus.PENDING,
      });
      expiryCron.recoverOwnerIfDocsClear.mockRejectedValue(
        new Error('downstream unavailable'),
      );

      const result = await service.reviewDocument(
        'doc-1',
        { status: DocumentStatus.APPROVED },
        ADMIN,
      );

      expect(result.status).toBe(DocumentStatus.APPROVED);
    });
  });

  describe('generateViewUrl', () => {
    it('owner sees their own document view-url', async () => {
      documentRepo.findOne.mockResolvedValue(buildDocument({}));
      adapter.generateViewUrl.mockResolvedValue('https://signed.example/get');

      const result = await service.generateViewUrl('doc-1', DRIVER);

      expect(result).toEqual({ viewUrl: 'https://signed.example/get' });
      expect(adapter.generateViewUrl).toHaveBeenCalledWith(
        'user/user-1/drivers_license/abc.jpg',
      );
    });

    it('admin sees any document view-url', async () => {
      documentRepo.findOne.mockResolvedValue(
        buildDocument({ ownerId: 'someone-else' }),
      );
      adapter.generateViewUrl.mockResolvedValue('https://signed.example/get');

      const result = await service.generateViewUrl('doc-1', ADMIN);

      expect(result.viewUrl).toBe('https://signed.example/get');
    });

    it('rejects non-owner non-admin (403)', async () => {
      documentRepo.findOne.mockResolvedValue(
        buildDocument({ ownerId: 'user-1' }),
      );
      await expect(
        service.generateViewUrl('doc-1', OTHER_DRIVER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(adapter.generateViewUrl).not.toHaveBeenCalled();
    });

    it('404 when document does not exist', async () => {
      documentRepo.findOne.mockResolvedValue(null);
      await expect(
        service.generateViewUrl('missing', ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404 when document row has no fileKey (legacy / pre-C1 placeholder)', async () => {
      documentRepo.findOne.mockResolvedValue(buildDocument({ fileKey: null }));
      await expect(
        service.generateViewUrl('doc-1', ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
