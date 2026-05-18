/* eslint-disable @typescript-eslint/unbound-method --
 * jest mock introspection is noisy under strict type-checked lint. */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { DocumentsService } from './documents.service';
import {
  Document,
  DocumentOwnerType,
  DocumentType,
  DocumentStatus,
} from './entities/document.entity';
import {
  SpacesStorageService,
  type PresignedUpload,
} from './spaces-storage.service';
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
    expiryDate: null,
    status: DocumentStatus.PENDING,
    uploadedBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Document;
}

describe('DocumentsService (ARCH-9)', () => {
  let service: DocumentsService;
  let documentRepo: jest.Mocked<Repository<Document>>;
  let storage: jest.Mocked<SpacesStorageService>;

  beforeEach(() => {
    documentRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Document>>;

    storage = {
      generateUploadUrl: jest.fn(),
      generateViewUrl: jest.fn(),
      objectExists: jest.fn(),
    } as unknown as jest.Mocked<SpacesStorageService>;

    service = new DocumentsService(documentRepo, storage);
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
      storage.generateUploadUrl.mockResolvedValue(presigned);

      const result = await service.generateUploadUrl(dto, DRIVER);

      expect(result).toBe(presigned);
      expect(storage.generateUploadUrl).toHaveBeenCalledWith(dto);
    });

    it('admin bypasses the owner check', async () => {
      const presigned: PresignedUpload = {
        uploadUrl: 'https://signed.example/put',
        objectKey: 'user/user-1/drivers_license/uuid.jpg',
      };
      storage.generateUploadUrl.mockResolvedValue(presigned);

      const result = await service.generateUploadUrl(dto, ADMIN);

      expect(result).toBe(presigned);
    });

    it('rejects non-admin trying to upload for another user (403)', async () => {
      await expect(
        service.generateUploadUrl(dto, OTHER_DRIVER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(storage.generateUploadUrl).not.toHaveBeenCalled();
    });

    it('rejects non-admin uploading vehicle docs until C2 lands', async () => {
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

    it('admin can upload vehicle docs (C2-gap workaround)', async () => {
      const presigned: PresignedUpload = {
        uploadUrl: 'https://signed.example/put',
        objectKey: 'vehicle/vehicle-1/vehicle_registration/uuid.pdf',
      };
      storage.generateUploadUrl.mockResolvedValue(presigned);

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
  });

  describe('generateViewUrl', () => {
    it('owner sees their own document view-url', async () => {
      documentRepo.findOne.mockResolvedValue(buildDocument({}));
      storage.generateViewUrl.mockResolvedValue('https://signed.example/get');

      const result = await service.generateViewUrl('doc-1', DRIVER);

      expect(result).toEqual({ viewUrl: 'https://signed.example/get' });
      expect(storage.generateViewUrl).toHaveBeenCalledWith(
        'user/user-1/drivers_license/abc.jpg',
      );
    });

    it('admin sees any document view-url', async () => {
      documentRepo.findOne.mockResolvedValue(
        buildDocument({ ownerId: 'someone-else' }),
      );
      storage.generateViewUrl.mockResolvedValue('https://signed.example/get');

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
      expect(storage.generateViewUrl).not.toHaveBeenCalled();
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
