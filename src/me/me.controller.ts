import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';
import { MeService } from './me.service';

class SetBvnDto {
  @IsString()
  @Matches(/^\d{11}$/, {
    message: 'BVN must be exactly 11 digits (Bank Verification Number).',
  })
  bvn: string;
}

class SetDriverBankAccountDto {
  @IsString()
  @Matches(/^[A-Za-z0-9 \-&,.()/]{2,80}$/, {
    message: 'Bank name must be 2-80 characters of letters, digits, and basic punctuation.',
  })
  bankName: string;

  @IsString()
  @Matches(/^[A-Za-z .'-]{2,120}$/, {
    message: 'Account name must be 2-120 letters, spaces, apostrophes, hyphens, or dots.',
  })
  accountName: string;

  @IsString()
  @Matches(/^\d{10}$/, {
    message: 'Account number must be exactly 10 digits.',
  })
  accountNumber: string;
}

/**
 * I1 — NDPA data-subject-rights endpoints. All routes are scoped to
 * the authenticated user.
 *   GET    /me/export   → JSON snapshot of first-party data.
 *   POST   /me/delete   → schedule deletion (30-day grace).
 *   DELETE /me/delete   → cancel a pending deletion request.
 *   POST   /me/consent  → record explicit policy consent.
 */
@ApiTags('Me')
@ApiBearerAuth()
@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeController {
  constructor(private readonly service: MeService) {}

  @Get('export')
  @ApiOperation({
    summary:
      'NDPA §31 — return a JSON snapshot of the caller`s first-party data.',
  })
  async export(@CurrentUser() user: User) {
    return this.service.export(user.id);
  }

  @Post('delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'NDPA §34 — schedule the caller`s account for pseudonymisation after a 30-day grace window. Idempotent.',
  })
  async requestDelete(@CurrentUser() user: User) {
    const updated = await this.service.requestDelete(user.id);
    return {
      deletionScheduledAt: updated.deletionScheduledAt,
      executesAt: updated.deletionScheduledAt
        ? new Date(
            updated.deletionScheduledAt.getTime() + 30 * 24 * 60 * 60 * 1000,
          )
        : null,
    };
  }

  @Delete('delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel a pending deletion request. Only valid within the 30-day grace window.',
  })
  async cancelDelete(@CurrentUser() user: User) {
    const updated = await this.service.cancelDeletion(user.id);
    return {
      deletionScheduledAt: updated.deletionScheduledAt,
    };
  }

  @Post('consent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'NDPA §32 / DR-N5 — record explicit acceptance of the privacy policy. Stamps users.consentedAt.',
  })
  async consent(@CurrentUser() user: User) {
    const updated = await this.service.consent(user.id);
    return { consentedAt: updated.consentedAt };
  }

  @Put('bvn')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'DR-NEW — store the caller`s Bank Verification Number (11 digits). Plaintext is encrypted at rest; only the last 4 digits are kept in plaintext for the masked admin display.',
  })
  async setBvn(@CurrentUser() user: User, @Body() dto: SetBvnDto) {
    return this.service.setBvn(user.id, dto.bvn);
  }

  @Get('bvn')
  @ApiOperation({
    summary:
      'Masked snapshot of the caller`s BVN. Returns { last4, updatedAt } or null when not yet provided.',
  })
  async getBvn(@CurrentUser() user: User) {
    return this.service.getBvnSnapshot(user.id);
  }

  // Phase 3 — driver bank account customers transfer their delivery
  // fee to. Driver-only; the service rejects non-drivers.
  @Put('driver/bank-account')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Driver sets or updates the bank account customers transfer their delivery fee to. Validates Nigerian bank-account shape (10-digit account number).',
  })
  async setDriverBankAccount(
    @CurrentUser() user: User,
    @Body() dto: SetDriverBankAccountDto,
  ) {
    return this.service.setDriverBankAccount(user.id, {
      bankName: dto.bankName.trim(),
      accountName: dto.accountName.trim(),
      accountNumber: dto.accountNumber.trim(),
    });
  }

  @Get('driver/bank-account')
  @ApiOperation({
    summary:
      'Read the caller`s saved driver bank account. Returns null when not yet set.',
  })
  async getDriverBankAccount(@CurrentUser() user: User) {
    return this.service.getDriverBankAccount(user.id);
  }
}
