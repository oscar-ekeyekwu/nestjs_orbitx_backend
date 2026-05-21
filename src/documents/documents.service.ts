import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Document,
  DocumentOwnerType,
  DocumentStatus,
} from './entities/document.entity';
import {
  Vehicle,
  VehicleOwnerType,
} from '../vehicles/entities/vehicle.entity';
import { VehicleAssignment } from '../vehicles/entities/vehicle-assignment.entity';
import { Company } from '../companies/entities/company.entity';
import {
  DriverProfile,
  DriverVerificationStatus,
} from '../drivers/entities/driver-profile.entity';
import { StorageRegistry } from '../storage/storage-registry.service';
import type { PresignedUpload } from '../storage/storage-adapter.interface';
import { GetUploadUrlDto } from './dto/get-upload-url.dto';
import { CreateDocumentDto } from './dto/create-document.dto';
import { ListDocumentsDto } from './dto/list-documents.dto';
import { ReviewDocumentDto } from './dto/review-document.dto';
import { DocumentExpiryCron } from './document-expiry.cron';
import {
  ApprovalAction,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
import { ApprovalsService } from '../approvals/approvals.service';
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  isAllowedDocumentMimeType,
  requiresExpiry,
} from './documents.constants';
import { ErrorCodes } from '../common/constants/error-codes';
import { UserRole } from '../common/enums/user-role.enum';
import { loadOwner, type OwnerType } from '../common/polymorphic';
import type { User } from '../users/entities/user.entity';

@Injectable()
export class DocumentsService {
  constructor(
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepo: Repository<Vehicle>,
    @InjectRepository(VehicleAssignment)
    private readonly assignmentRepo: Repository<VehicleAssignment>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(DriverProfile)
    private readonly driverProfileRepo: Repository<DriverProfile>,
    private readonly storageRegistry: StorageRegistry,
    private readonly dataSource: DataSource,
    private readonly expiryCron: DocumentExpiryCron,
    private readonly approvalsService: ApprovalsService,
    private readonly events: EventEmitter2,
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
      await this.assertOwnerMatchesCaller(dto.ownerType, dto.ownerId, caller);
    }
    const adapter = await this.storageRegistry.getActive();
    return adapter.generateUploadUrl(dto);
  }

  /**
   * C1 + C2 — persist the Document metadata row after the client
   * confirms the PUT succeeded.
   *
   *   - C1: HEAD Spaces to verify the bytes actually landed before
   *     writing the row (FILE_002 on miss).
   *   - C2: validate expiry-required types (DOCUMENT_001 on missing
   *     expiry) and polymorphic owner ref (DOCUMENT_002 on missing
   *     owner).
   *
   * Multi-version doc history (C2 AC): re-uploading the same docType
   * for the same owner simply inserts a new row at status='pending'.
   * The prior approved row stays untouched — no UPDATE, no DELETE.
   * Admin queries should ORDER BY createdAt DESC to surface the
   * latest version per (ownerType, ownerId, type) tuple.
   */
  async createDocument(
    dto: CreateDocumentDto,
    caller: User,
  ): Promise<Document> {
    if (caller.role !== UserRole.ADMIN) {
      await this.assertOwnerMatchesCaller(dto.ownerType, dto.ownerId, caller);
    }

    this.assertObjectKeyMatchesOwner(dto);

    if (requiresExpiry(dto.docType) && !dto.expiryDate) {
      throw new BadRequestException({
        message: `Document type "${dto.docType}" requires an expiryDate.`,
        errorCode: ErrorCodes.DOCUMENT_001,
      });
    }

    await this.assertOwnerExists(dto.ownerType, dto.ownerId);

    // STG-1 — the active provider at create time owns the document for
    // its entire lifetime; the doc's `storageProviderId` is what later
    // view-url lookups read, NOT the active provider (which may swap).
    const adapter = await this.storageRegistry.getActive();
    const exists = await adapter.objectExists(dto.fileKey);
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
      fileUrl: adapter.canonicalUri(dto.fileKey),
      storageProviderId: adapter.providerId,
      expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
      status: DocumentStatus.PENDING,
      uploadedBy: caller.id,
      reviewedAt: null,
      reviewedBy: null,
      rejectionReason: null,
    });
    const saved = await this.documentRepo.save(doc);

    // Doc re-upload side effect — if the upload belongs to a driver
    // who is already approved/active, flip them back to pending_approval
    // so an admin re-reviews the new bytes before they keep operating.
    // No-op for setup_required (the wizard handles that path) or
    // suspended/rejected (other state-machine edges own those).
    await this.maybeRequeueDriverForReview(dto.ownerType, dto.ownerId);

    return saved;
  }

  /**
   * Resolve a doc owner to a driver_profile and, if that driver is in
   * APPROVED or ACTIVE, transition them to PENDING_APPROVAL via the
   * system role. Best-effort: a failure here doesn't roll back the
   * doc create. The C4 expiry cron's recovery hook reconciles in the
   * rare case this misses.
   */
  private async maybeRequeueDriverForReview(
    ownerType: DocumentOwnerType,
    ownerId: string,
  ): Promise<void> {
    try {
      let profile: DriverProfile | null = null;
      if (ownerType === DocumentOwnerType.USER) {
        profile = await this.driverProfileRepo.findOne({
          where: { userId: ownerId },
        });
      } else if (ownerType === DocumentOwnerType.VEHICLE) {
        const vehicle = await this.vehicleRepo.findOne({
          where: { id: ownerId },
        });
        if (!vehicle) return;
        if (vehicle.ownerType === VehicleOwnerType.INDIVIDUAL_DRIVER) {
          profile = await this.driverProfileRepo.findOne({
            where: { id: vehicle.ownerId },
          });
        }
        // Company-owned vehicles intentionally don't requeue the driver
        // here — the company's KYC is the relevant subject.
      }
      if (!profile) return;
      const requeueable =
        profile.verificationStatus === DriverVerificationStatus.APPROVED ||
        profile.verificationStatus === DriverVerificationStatus.ACTIVE;
      if (!requeueable) return;
      profile.verificationStatus = DriverVerificationStatus.PENDING_APPROVAL;
      // Force them offline — re-review is in progress and dispatch
      // shouldn't see this driver until an admin re-approves.
      profile.isOnline = false;
      await this.driverProfileRepo.save(profile);
      // Audit trail: record why the driver fell out of active so the
      // admin can trace it later. NDPA / LASAA event log requirements.
      await this.approvalsService.recordDecision(this.dataSource.manager, {
        targetType: ApprovalTargetType.DRIVER,
        targetId: profile.id,
        action: ApprovalAction.SUSPEND,
        reviewerId: null,
        reason: 'Driver document re-uploaded — pending admin re-review.',
      });
    } catch {
      // Best-effort — log-and-forget would be ideal here but the
      // service's logger isn't wired in yet. Failure leaves the
      // driver in their prior status; the next admin review on the
      // new pending doc still picks them up.
    }
  }

  /**
   * C2 — list documents with optional filters.
   *
   * Admin can list across all owners. Non-admin callers have the
   * (ownerType=user, ownerId=caller.id) filter forced regardless of
   * what they pass in — a driver cannot list another user's docs even
   * by spoofing the query string.
   */
  async listDocuments(
    filters: ListDocumentsDto,
    caller: User,
  ): Promise<Document[]> {
    const where: Record<string, unknown> = {};

    if (caller.role === UserRole.ADMIN) {
      if (filters.ownerType) where.ownerType = filters.ownerType;
      if (filters.ownerId) where.ownerId = filters.ownerId;
    } else if (
      filters.ownerType &&
      filters.ownerType !== DocumentOwnerType.USER &&
      filters.ownerId
    ) {
      // Non-admin asking for a non-user owner (e.g. vehicle / company)
      // needs to prove they are authorized for THAT specific owner.
      // Reuses the same owner-check the upload/view paths use so the
      // KYC wizard can hydrate its "already uploaded" state on login
      // without leaking another driver's vehicle docs.
      await this.assertOwnerMatchesCaller(
        filters.ownerType,
        filters.ownerId,
        caller,
      );
      where.ownerType = filters.ownerType;
      where.ownerId = filters.ownerId;
    } else {
      // Default for non-admins: scope to their own user docs. Any
      // attempt to pass a different ownerType WITHOUT ownerId is
      // ignored rather than rejected to keep the surface simple.
      where.ownerType = DocumentOwnerType.USER;
      where.ownerId = caller.id;
    }

    if (filters.type) where.type = filters.type;
    if (filters.status) where.status = filters.status;

    // H5 — admin-only `expiringInDays` window. Includes already-expired
    // docs (expiryDate <= now+windowMs) so an admin can still spot a
    // recently-expired cert that hasn't been renewed yet. Documents
    // with NULL expiry are NOT matched (the filter is opt-in narrow).
    if (
      caller.role === UserRole.ADMIN &&
      typeof filters.expiringInDays === 'number'
    ) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + filters.expiringInDays);
      where.expiryDate = LessThanOrEqual(cutoff);
    }

    return this.documentRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * C2 — fetch a single document. Admin sees any; non-admin only sees
   * documents they own (ownerType=user, ownerId=caller.id).
   */
  async findOne(id: string, caller: User): Promise<Document> {
    const doc = await this.documentRepo.findOne({ where: { id } });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }
    if (caller.role !== UserRole.ADMIN) {
      await this.assertOwnerMatchesCaller(doc.ownerType, doc.ownerId, caller);
    }
    return doc;
  }

  /**
   * C5 — admin approves or rejects a pending document. Wraps the
   * status flip + approval_decisions insert in a single transaction.
   *
   * On approve, the cron's `recoverOwnerIfDocsClear` hook is called
   * AFTER the commit so a freshly-approved license can lift a
   * `suspended_docs_expired` driver back to ACTIVE in one round-trip.
   * The hook is idempotent and short-circuits cheaply when other
   * expired docs remain.
   *
   * Rejection records the reason on the document row so the owner
   * sees actionable feedback when they re-upload.
   */
  async reviewDocument(
    documentId: string,
    dto: ReviewDocumentDto,
    caller: User,
  ): Promise<Document> {
    const allowed: DocumentStatus[] = [
      DocumentStatus.APPROVED,
      DocumentStatus.REJECTED,
    ];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException({
        message: `Review status must be one of: ${allowed.join(', ')}.`,
        errorCode: ErrorCodes.VAL_002,
      });
    }
    if (dto.status === DocumentStatus.REJECTED && !dto.reason?.trim()) {
      throw new BadRequestException({
        message: 'A rejection reason is required.',
        errorCode: ErrorCodes.VAL_003,
      });
    }

    const reviewed = await this.dataSource.transaction(async (manager) => {
      const doc = await manager.findOne(Document, {
        where: { id: documentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!doc) {
        throw new NotFoundException(`Document ${documentId} not found`);
      }
      if (doc.status !== DocumentStatus.PENDING) {
        // Once a doc is approved / rejected / expired, re-reviewing it
        // would silently overwrite the audit trail. Force the admin to
        // ask the owner to upload a fresh copy instead.
        throw new BadRequestException({
          message: `Document is not pending review (current status: ${doc.status}).`,
          errorCode: ErrorCodes.VAL_002,
        });
      }

      doc.status = dto.status;
      doc.reviewedAt = new Date();
      doc.reviewedBy = caller.id;
      doc.rejectionReason =
        dto.status === DocumentStatus.REJECTED ? (dto.reason ?? null) : null;
      await manager.save(doc);

      await this.approvalsService.recordDecision(manager, {
        targetType: ApprovalTargetType.DOCUMENT,
        targetId: doc.id,
        action:
          dto.status === DocumentStatus.APPROVED
            ? ApprovalAction.APPROVE
            : ApprovalAction.REJECT,
        reviewerId: caller.id,
        reason: dto.reason,
      });

      return doc;
    });

    // C4 recovery hook — fires only on approval, after the commit, so a
    // failure inside the hook can't roll back the review itself.
    if (reviewed.status === DocumentStatus.APPROVED) {
      await this.expiryCron
        .recoverOwnerIfDocsClear(reviewed.ownerType, reviewed.ownerId)
        .catch(() => {
          // Recovery is best-effort: if it fails, the doc is still
          // approved and the next nightly sweep will reconcile.
        });
    }

    // ARCH-10: notify the owner via push. Emit AFTER the transaction
    // commits and the recovery hook runs so subscribers see the final
    // post-recovery state. The fanout listener is fire-and-forget.
    const reviewEventName =
      reviewed.status === DocumentStatus.APPROVED
        ? 'document.approved'
        : 'document.rejected';
    this.events.emit(reviewEventName, {
      documentId: reviewed.id,
      userId:
        reviewed.ownerType === DocumentOwnerType.USER ? reviewed.ownerId : '',
      reason: reviewed.rejectionReason,
    });

    return reviewed;
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
      await this.assertOwnerMatchesCaller(doc.ownerType, doc.ownerId, caller);
    }
    if (!doc.fileKey) {
      // Document was created without an S3 key (legacy data or
      // pre-C1 placeholder). Nothing to view.
      throw new NotFoundException(`Document ${documentId} has no stored file`);
    }
    if (!doc.storageProviderId) {
      // Transitional safety net for the bootstrap window — after STG-1
      // migrations run, every document has a storageProviderId. If a
      // row makes it past the NOT NULL constraint, refuse to silently
      // route it to the active provider.
      throw new NotFoundException(
        `Document ${documentId} has no recorded storage provider`,
      );
    }
    const adapter = await this.storageRegistry.get(doc.storageProviderId);
    const viewUrl = await adapter.generateViewUrl(doc.fileKey);
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

  /**
   * C2 — verify the (ownerType, ownerId) pair actually resolves to a
   * row. Uses the polymorphic loader (ARCH-4) so adding a new owner
   * type only needs OwnerType + the switch updated.
   */
  private async assertOwnerExists(
    ownerType: DocumentOwnerType,
    ownerId: string,
  ): Promise<void> {
    // DocumentOwnerType ⊂ OwnerType — the cast is safe because the
    // enum values match the union literals.
    const owner = await loadOwner(
      this.dataSource.manager,
      ownerType as unknown as OwnerType,
      ownerId,
    );
    if (!owner) {
      throw new BadRequestException({
        message: `No ${ownerType} found with id ${ownerId}.`,
        errorCode: ErrorCodes.DOCUMENT_002,
      });
    }
  }

  /**
   * Non-admin authorization for the upload / register / view paths.
   *
   *   user     — ownerId must equal caller.id.
   *   vehicle  — caller must be (a) the individual-driver owner,
   *              (b) the creator of the owning company, or
   *              (c) an actively-assigned driver on the vehicle.
   *   company  — caller must be the creator of the company.
   */
  private async assertOwnerMatchesCaller(
    ownerType: DocumentOwnerType,
    ownerId: string,
    caller: User,
  ): Promise<void> {
    if (ownerType === DocumentOwnerType.USER) {
      if (ownerId !== caller.id) {
        throw new ForbiddenException(
          'You can only manage documents owned by your own user.',
        );
      }
      return;
    }

    if (ownerType === DocumentOwnerType.VEHICLE) {
      const vehicle = await this.vehicleRepo.findOne({
        where: { id: ownerId },
      });
      if (!vehicle) {
        throw new NotFoundException(`Vehicle ${ownerId} not found`);
      }
      // INDIVIDUAL_DRIVER vehicles store the driver_profile.id (NOT the
      // user.id) in vehicle.ownerId — see VehiclesService.create. Resolve
      // the profile and check its userId against the caller.
      if (vehicle.ownerType === VehicleOwnerType.INDIVIDUAL_DRIVER) {
        const profile = await this.driverProfileRepo.findOne({
          where: { id: vehicle.ownerId, userId: caller.id },
        });
        if (profile) {
          return;
        }
      }
      if (vehicle.ownerType === VehicleOwnerType.COMPANY) {
        const company = await this.companyRepo.findOne({
          where: { id: vehicle.ownerId, createdBy: caller.id },
        });
        if (company) {
          return;
        }
      }
      const activeAssignment = await this.assignmentRepo.findOne({
        where: {
          vehicleId: vehicle.id,
          driverId: caller.id,
          unassignedAt: IsNull(),
        },
      });
      if (activeAssignment) {
        return;
      }
      throw new ForbiddenException(
        'You can only manage documents for vehicles you own, your company owns, or you are actively assigned to.',
      );
    }

    if (ownerType === DocumentOwnerType.COMPANY) {
      const company = await this.companyRepo.findOne({
        where: { id: ownerId, createdBy: caller.id },
      });
      if (!company) {
        throw new ForbiddenException(
          'You can only manage documents for companies you own.',
        );
      }
      return;
    }

    throw new ForbiddenException(`Unsupported ownerType: ${ownerType}`);
  }
}
