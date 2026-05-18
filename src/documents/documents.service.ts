import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Document,
  DocumentOwnerType,
  DocumentStatus,
} from './entities/document.entity';
import {
  SpacesStorageService,
  type PresignedUpload,
} from './spaces-storage.service';
import { GetUploadUrlDto } from './dto/get-upload-url.dto';
import { CreateDocumentDto } from './dto/create-document.dto';
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  isAllowedDocumentMimeType,
} from './documents.constants';
import { ErrorCodes } from '../common/constants/error-codes';
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
   * ARCH-9 / C1 — issue a presigned PUT url. Validates the requested
   * MIME against the allowlist before signing so a bad type fails
   * fast (FILE_001) rather than producing a signed url the client
   * can't actually use.
   */
  async generateUploadUrl(
    dto: GetUploadUrlDto,
    caller: User,
  ): Promise<PresignedUpload> {
    this.assertAllowedMime(dto.contentType);
    if (caller.role !== UserRole.ADMIN) {
      this.assertOwnerMatchesCaller(dto.ownerType, dto.ownerId, caller);
    }
    return this.storage.generateUploadUrl(dto);
  }

  /**
   * C1 — persist the Document metadata row after the client confirms
   * the PUT succeeded. The backend HEADs Spaces to verify the bytes
   * actually landed before writing the row (FILE_002 on miss), so a
   * stale or aborted upload never creates an orphan record.
   *
   * Status is always seeded as PENDING — admin approval lives in C5.
   */
  async createDocument(
    dto: CreateDocumentDto,
    caller: User,
  ): Promise<Document> {
    if (caller.role !== UserRole.ADMIN) {
      this.assertOwnerMatchesCaller(dto.ownerType, dto.ownerId, caller);
    }

    this.assertObjectKeyMatchesOwner(dto);

    const exists = await this.storage.objectExists(dto.fileKey);
    if (!exists) {
      throw new BadRequestException({
        message:
          'Upload not found in storage. The presigned upload-url may have expired before the PUT completed — please request a fresh upload-url and retry.',
        errorCode: ErrorCodes.FILE_002,
      });
    }

    const doc = this.documentRepo.create({
      ownerType: dto.ownerType,
      ownerId: dto.ownerId,
      type: dto.docType,
      fileKey: dto.fileKey,
      fileUrl: this.storage.getCanonicalUri(dto.fileKey),
      expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
      status: DocumentStatus.PENDING,
      uploadedBy: caller.id,
    });
    return this.documentRepo.save(doc);
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

  private assertAllowedMime(contentType: string): void {
    if (!isAllowedDocumentMimeType(contentType)) {
      throw new BadRequestException({
        message: `Unsupported content type "${contentType}". Allowed: ${ALLOWED_DOCUMENT_MIME_TYPES.join(', ')}.`,
        errorCode: ErrorCodes.FILE_001,
      });
    }
  }

  /**
   * Cross-check the supplied objectKey against the supplied owner facets.
   * The presign step builds keys as `<ownerType>/<ownerId>/<docType>/<uuid>.<ext>`;
   * if the caller hands back a key with a different prefix, we reject
   * the metadata POST so a user can't smuggle another owner's upload
   * into their own row.
   */
  private assertObjectKeyMatchesOwner(dto: CreateDocumentDto): void {
    const expectedPrefix = `${dto.ownerType}/${dto.ownerId}/${dto.docType}/`;
    if (!dto.fileKey.startsWith(expectedPrefix)) {
      throw new BadRequestException({
        message:
          'fileKey does not match the supplied ownerType / ownerId / docType. Request a fresh upload-url and retry.',
        errorCode: ErrorCodes.FILE_002,
      });
    }
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
