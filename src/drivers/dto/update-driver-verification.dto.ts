import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DriverVerificationStatus } from '../entities/driver-profile.entity';

/**
 * C5 — admin patches a driver's verification status. The transition
 * must be allowed by driverStateMachine (ARCH-3); the call wraps a
 * row write + approval_decisions insert in a single transaction.
 */
export class UpdateDriverVerificationDto {
  @ApiProperty({
    enum: DriverVerificationStatus,
    example: DriverVerificationStatus.APPROVED,
    description:
      'Target verification status. The edge must be in driverStateMachine — e.g. pending_approval → approved | rejected.',
  })
  @IsEnum(DriverVerificationStatus)
  status: DriverVerificationStatus;

  @ApiProperty({
    example: 'Driver license + NIN verified; selfie matches.',
    description:
      'Audit-trail reason captured in approval_decisions. Required for reject / suspend; recommended for approve.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
