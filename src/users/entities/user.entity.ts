import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { Exclude, Expose } from 'class-transformer';
import * as bcrypt from 'bcrypt';
import { UserRole } from '../../common/enums/user-role.enum';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column()
  first_name: string;

  @Column()
  last_name: string;

  @Column({ nullable: true })
  @Exclude()
  password: string;

  @Column({ nullable: true, unique: true })
  phone: string;

  @Column({ nullable: true })
  avatar: string;

  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.CUSTOMER,
  })
  role: UserRole;

  @Column({ nullable: true })
  googleId: string;

  @Column({ default: false })
  isEmailVerified: boolean;

  @Column({ default: false })
  isPhoneVerified: boolean;

  @Column({ default: true })
  isActive: boolean;

  /**
   * G4 — Paystack transfer-recipient code, populated when the user
   * onboards a payout bank account. Null while no auto-transfer
   * destination is on file; the cron routes these recipients to the
   * manual disbursement queue instead. v1 ships without the
   * onboarding UI for this field — admin populates it manually as
   * needed; a future story adds the self-serve flow.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  paystackRecipientCode: string | null;

  // I1 — NDPA data-subject-rights columns.
  @Column({ type: 'timestamp with time zone', nullable: true })
  consentedAt: Date | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  deletionScheduledAt: Date | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  pseudonymizedAt: Date | null;

  // DR-NEW — Bank Verification Number (BVN) collected during driver
  // KYC. Encrypted at rest with AES-256-GCM via StorageCryptoService
  // (same KEK + cipher/nonce/tag pattern as storage-provider secrets).
  // Plaintext never persists; admins see `bvnLast4` masked behind
  // `•••••••` and can request a one-shot decrypt for verification.
  @Column({ type: 'bytea', nullable: true })
  @Exclude()
  bvnCipher: Buffer | null;

  @Column({ type: 'bytea', nullable: true })
  @Exclude()
  bvnNonce: Buffer | null;

  @Column({ type: 'bytea', nullable: true })
  @Exclude()
  bvnTag: Buffer | null;

  @Column({ type: 'smallint', nullable: true })
  bvnKeyVersion: number | null;

  // Last 4 digits cached for masked display ("•••••••1234"). Cheap
  // join-free lookup for the admin driver-detail page.
  @Column({ type: 'varchar', length: 4, nullable: true })
  bvnLast4: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  bvnUpdatedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  /**
   * Virtual field — not in the DB
   * Computed on the fly and exposed during serialization
   */
  @Expose()
  get name(): string {
    return `${this.first_name} ${this.last_name}`.trim();
  }

  @BeforeInsert()
  @BeforeUpdate()
  async hashPassword() {
    if (this.password && !this.password.startsWith('$2b$')) {
      this.password = await bcrypt.hash(this.password, 10);
    }
  }

  async validatePassword(password: string): Promise<boolean> {
    if (!this.password) return false;
    return bcrypt.compare(password, this.password);
  }
}
