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
 * CBN) — see PRD §DR table.
 */
export enum DocumentType {
  DRIVERS_LICENSE = 'drivers_license',
  NIN = 'nin',
  PROOF_OF_ADDRESS = 'proof_of_address',
  VEHICLE_REGISTRATION = 'vehicle_registration',
  ROADWORTHY = 'roadworthy',
  INSURANCE = 'insurance',
  LASAA_PERMIT = 'lasaa_permit',
  NIPOST_LICENSE = 'nipost_license',
  CAC_CERTIFICATE = 'cac_certificate',
  TIN_CERTIFICATE = 'tin_certificate',
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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
