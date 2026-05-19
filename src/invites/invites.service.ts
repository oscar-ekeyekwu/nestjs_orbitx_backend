import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { EntityManager } from 'typeorm';
import { Repository } from 'typeorm';
import { DriverInvite } from './entities/driver-invite.entity';
import { Company, CompanyStatus } from '../companies/entities/company.entity';
import { ErrorCodes } from '../common/constants/error-codes';
import { UserRole } from '../common/enums/user-role.enum';
import { SmsService } from '../notifications/sms.service';
import type { User } from '../users/entities/user.entity';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreatedInvite {
  id: string;
  token: string;
  expiresAt: Date;
  phone: string;
  companyId: string;
  inviteUrl: string;
}

/**
 * D4 — invite lifecycle.
 *
 * Create:
 *   - Only ADMIN or the company's createdBy can mint invites for a
 *     company, and only when the company is APPROVED. A pending /
 *     suspended company shouldn't be onboarding new drivers.
 *   - Token defaults to a fresh uuid; expiresAt = now + 7 days.
 *   - SMS dispatch is best-effort — SMS failure does NOT roll back
 *     the invite. The company_owner can manually share the link
 *     from the admin console / mobile if the SMS got stuck.
 *
 * Redeem:
 *   - Called from AuthService.register when the registration payload
 *     carries an inviteToken. Validates not-expired, not-used; on
 *     success, marks the invite used + sets redeemedByUserId in the
 *     same transaction as the user/profile insert.
 */
@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);

  constructor(
    @InjectRepository(DriverInvite)
    private readonly inviteRepo: Repository<DriverInvite>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    private readonly sms: SmsService,
  ) {}

  async createInvite(
    companyId: string,
    phone: string,
    caller: User,
  ): Promise<CreatedInvite> {
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
    });
    if (!company) {
      throw new NotFoundException(`Company ${companyId} not found`);
    }
    if (caller.role !== UserRole.ADMIN && company.createdBy !== caller.id) {
      throw new ForbiddenException(
        'Only the company owner or an admin can invite drivers.',
      );
    }
    if (company.status !== CompanyStatus.APPROVED) {
      throw new BadRequestException({
        errorCode: ErrorCodes.COMPANY_001,
        message:
          'Only an approved company can invite drivers. Wait for admin approval, then retry.',
      });
    }

    const expiresAt = new Date(Date.now() + SEVEN_DAYS_MS);
    const invite = this.inviteRepo.create({
      companyId,
      phone,
      expiresAt,
      usedAt: null,
      redeemedByUserId: null,
      createdBy: caller.id,
    });
    const saved = await this.inviteRepo.save(invite);

    const inviteUrl = `orbitx://invite/${saved.token}`;
    void this.dispatchSms(phone, company.legalName, inviteUrl);

    return {
      id: saved.id,
      token: saved.token,
      expiresAt: saved.expiresAt,
      phone: saved.phone,
      companyId: saved.companyId,
      inviteUrl,
    };
  }

  /**
   * D4 — redeem an invite token in the same transaction that creates
   * the user + driver_profile. The EntityManager is supplied by the
   * caller (AuthService.register); InvitesService just owns the
   * lock + validate + mark-used semantics.
   *
   * Returns the invite's companyId so the caller can link the new
   * driver_profile + company_memberships row in the same transaction.
   *
   * Throws:
   *   INVITE_003 — token doesn't match any row
   *   INVITE_002 — already redeemed
   *   INVITE_001 — expired
   */
  async redeemInTransaction(
    manager: EntityManager,
    token: string,
    redeemedByUserId: string,
  ): Promise<{ companyId: string; inviteId: string }> {
    const invite = await manager.findOne(DriverInvite, {
      where: { token },
      lock: { mode: 'pessimistic_write' },
    });
    if (!invite) {
      throw new BadRequestException({
        errorCode: ErrorCodes.INVITE_003,
        message: 'Invite link is invalid.',
      });
    }
    if (invite.usedAt) {
      throw new BadRequestException({
        errorCode: ErrorCodes.INVITE_002,
        message: 'This invite has already been used.',
      });
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException({
        errorCode: ErrorCodes.INVITE_001,
        message:
          'This invite has expired. Please ask the company to send a new one.',
      });
    }

    invite.usedAt = new Date();
    invite.redeemedByUserId = redeemedByUserId;
    await manager.save(invite);

    return { companyId: invite.companyId, inviteId: invite.id };
  }

  async listForCompany(
    companyId: string,
    caller: User,
  ): Promise<DriverInvite[]> {
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
    });
    if (!company) {
      throw new NotFoundException(`Company ${companyId} not found`);
    }
    if (caller.role !== UserRole.ADMIN && company.createdBy !== caller.id) {
      throw new ForbiddenException(
        'Only the company owner or an admin can list invites.',
      );
    }
    return this.inviteRepo.find({
      where: { companyId },
      order: { createdAt: 'DESC' },
    });
  }

  private async dispatchSms(
    phone: string,
    companyName: string,
    inviteUrl: string,
  ): Promise<void> {
    try {
      const message =
        `You have been invited to drive for ${companyName} on Orbit. ` +
        `Tap to register: ${inviteUrl}`;
      await this.sms.sendSms(phone, message);
    } catch (err) {
      // SMS failure must NEVER roll back the invite — the owner can
      // manually share the link. Just log loud enough for oncall.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Invite SMS dispatch failed for ${phone}: ${msg}. Token still valid.`,
      );
    }
  }
}
