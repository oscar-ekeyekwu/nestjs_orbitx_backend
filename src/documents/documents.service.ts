import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Document, DocumentOwnerType } from './entities/document.entity';
import {
  SpacesStorageService,
  type PresignedUpload,
} from './spaces-storage.service';
import { GetUploadUrlDto } from './dto/get-upload-url.dto';
import { UserRole } from '../common/enums/user-role.enum';
import type { User } from '../users/entities/user.entity';

@Injectable()
export class DocumentsService {
  constructor(
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    private readonly storage: SpacesStorageService,
  ) {}

  /**
   * ARCH-9 — issue a presigned PUT url for the client to upload a
   * KYC document straight to Spaces. The backend never sees the
   * bytes.
   *
   * Authorization: for ownerType='user', ownerId MUST match the
   * caller's user id. Vehicle / company owner checks are deferred
   * to C2 (full Documents CRUD service) — they need polymorphic-
   * owner lookups through VehiclesService / CompaniesService which
   * land alongside the metadata endpoint.
   */
  async generateUploadUrl(
    dto: GetUploadUrlDto,
    caller: User,
  ): Promise<PresignedUpload> {
    if (caller.role !== UserRole.ADMIN) {
      this.assertOwnerMatchesCaller(dto.ownerType, dto.ownerId, caller);
    }
    return this.storage.generateUploadUrl(dto);
  }

  /**
   * ARCH-9 — issue a presigned GET url for an existing document.
   * Authorization mirrors the upload path: admin or matching owner.
   */
  async generateViewUrl(
    documentId: string,
    caller: User,
  ): Promise<{ viewUrl: string }> {
    const doc = await this.documentRepo.findOne({
      where: { id: documentId },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${documentId} not found`);
    }
    if (caller.role !== UserRole.ADMIN) {
      this.assertOwnerMatchesCaller(doc.ownerType, doc.ownerId, caller);
    }
    if (!doc.fileKey) {
      // Document was created without an S3 key (legacy data or
      // pre-C1 placeholder). Nothing to view.
      throw new NotFoundException(`Document ${documentId} has no stored file`);
    }
    const viewUrl = await this.storage.generateViewUrl(doc.fileKey);
    return { viewUrl };
  }

  private assertOwnerMatchesCaller(
    ownerType: DocumentOwnerType,
    ownerId: string,
    caller: User,
  ): void {
    if (ownerType === DocumentOwnerType.USER) {
      if (ownerId !== caller.id) {
        throw new ForbiddenException(
          'You can only manage documents owned by your own user.',
        );
      }
      return;
    }
    // Vehicle + company ownership checks land in C2 (requires the
    // polymorphic-owner loader). Until then, only admins can act on
    // those — keeps the surface safe by default.
    throw new ForbiddenException(
      `Owner check for ownerType=${ownerType} is admin-only until C2 lands the full Documents service.`,
    );
  }
}
