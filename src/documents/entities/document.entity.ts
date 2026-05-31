import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum DocumentOwnerType {
  USER = 'user',
  VEHICLE = 'vehicle',
  COMPANY = 'company',
}

/**
 * Catalog of document types accepted by KYC + compliance flows. New types
 * land here only after a regulator citation (NDPA, LASAA, NIPOST, FRSC,
 * CBN) — see PRD §DR table. C2 added gov_id / director_id / selfie to
 * cover the company director + facial-match flows.
 */
export enum DocumentType {
  DRIVERS_LICENSE = 'drivers_license',
  NIN = 'nin',
  PASSPORT = 'passport',
  VOTERS_CARD = 'voters_card',
  PROOF_OF_ADDRESS = 'proof_of_address',
  VEHICLE_REGISTRATION = 'vehicle_registration',
  // Annual vehicle license / road-tax certificate. Distinct from
  // VEHICLE_REGISTRATION which is the ownership/registration cert.
  VEHICLE_LICENSE = 'vehicle_license',
  // Photo of the vehicle showing the registration plate. Stored as a
  // Document row (reviewable) so it can be expired/replaced on the
  // same lifecycle as the other vehicle compliance artefacts; the
  // legacy `vehicles.photoUrl` is kept for now and mirrors the
  // most recent VEHICLE_PHOTO upload.
  VEHICLE_PHOTO = 'vehicle_photo',
  ROADWORTHY = 'roadworthy',
  INSURANCE = 'insurance',
  // LASDRI / Rider's Card permit issued by Lagos State to commercial
  // motorcycle/tricycle riders. Stored under the legacy enum value
  // `lasaa_permit` for back-compat with existing seed data; the UI
  // surfaces it as "Rider's Card (LASDRI)."
  LASAA_PERMIT = 'lasaa_permit',
  NIPOST_LICENSE = 'nipost_license',
  CAC_CERTIFICATE = 'cac_certificate',
  TIN_CERTIFICATE = 'tin_certificate',
  // Umbrella government-issued ID. PASSPORT + VOTERS_CARD are now
  // explicit values; GOV_ID is retained for company-director records
  // that pre-date the split.
  GOV_ID = 'gov_id',
  DIRECTOR_ID = 'director_id',
  SELFIE = 'selfie',
}

export enum DocumentStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
}

@Entity('documents')
export class Document {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({
    type: 'enum',
    enum: DocumentOwnerType,
  })
  ownerType: DocumentOwnerType;

  @Index()
  @Column({ type: 'uuid' })
  ownerId: string;

  @Index()
  @Column({
    type: 'enum',
    enum: DocumentType,
  })
  type: DocumentType;

  @Column()
  fileUrl: string;

  @Column({ type: 'varchar', nullable: true })
  fileKey: string | null;

  // STG-1 — which storage provider this document physically lives in.
  // FK to storage_providers.id. Nullable in the schema only during the
  // bootstrap-migration transition window; backfill within the same
  // migration tightens it to NOT NULL before the app starts serving.
  @Index()
  @Column({ type: 'uuid', nullable: true })
  storageProviderId: string | null;

  @Column({ type: 'date', nullable: true })
  expiryDate: Date | null;

  @Index()
  @Column({
    type: 'enum',
    enum: DocumentStatus,
    default: DocumentStatus.PENDING,
  })
  status: DocumentStatus;

  @Column({ type: 'uuid' })
  uploadedBy: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'uploadedBy' })
  uploader: User;

  // C2: review trail. Populated when an admin approves or rejects the
  // document in C5. Always null while status='pending'.
  @Column({ type: 'timestamp', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  reviewedBy: string | null;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'reviewedBy' })
  reviewer: User | null;

  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  // `createdAt` is the upload time per C2 AC ("uploaded_at=now()").
  // Kept under the camelCase TypeORM convention so the JSON envelope
  // stays consistent with the rest of the API.
  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
