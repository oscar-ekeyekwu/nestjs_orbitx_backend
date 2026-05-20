import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../common/enums/user-role.enum';
import { User } from '../users/entities/user.entity';
import { DeleteSourceDto } from './dto/delete-source.dto';
import { QueueStorageMigrationDto } from './dto/queue-storage-migration.dto';
import type { StorageMigrationDeletion } from './entities/storage-migration-deletion.entity';
import type { StorageMigrationVerification } from './entities/storage-migration-verification.entity';
import type { StorageMigration } from './entities/storage-migration.entity';
import {
  StorageMigrationService,
  type StorageMigrationFailureView,
} from './storage-migration.service';

@ApiTags('Admin · Storage Migrations')
@ApiBearerAuth()
@Controller('admin/storage')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class StorageMigrationsController {
  constructor(private readonly service: StorageMigrationService) {}

  @Post('migrate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Queue a cross-provider migration and kick the in-process worker. Returns 409 if another migration is already running.',
  })
  async start(
    @CurrentUser() user: User,
    @Body() dto: QueueStorageMigrationDto,
  ): Promise<StorageMigration> {
    return this.service.start(dto, user.id);
  }

  @Get('migrations')
  @ApiOperation({
    summary: 'List recent storage migrations (most recent first).',
  })
  async list(): Promise<StorageMigration[]> {
    return this.service.list();
  }

  @Get('migrations/:id')
  @ApiOperation({ summary: 'Fetch a single migration row.' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StorageMigration> {
    return this.service.findOne(id);
  }

  @Get('migrations/:id/failures')
  @ApiOperation({ summary: 'List per-document failures for a migration.' })
  async failures(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StorageMigrationFailureView[]> {
    return this.service.listFailures(id);
  }

  @Post('migrations/:id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Request a cooperative pause. The worker finishes the in-flight document then stops; subsequent resume picks up at the next id.',
  })
  async pause(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StorageMigration> {
    return this.service.pause(id, user.id);
  }

  @Post('migrations/:id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resume a paused migration from its lastDocumentId cursor. Returns 409 if another migration is already running.',
  })
  async resume(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StorageMigration> {
    return this.service.resume(id, user.id);
  }

  // STG-5 ──────────────────────────────────────────────────────────────────

  @Post('migrations/:id/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Run a verify pass against the destination provider for every doc the migration moved. Returns 409 with VERIFY_ALREADY_RUNNING when one is already in flight.',
  })
  async verify(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StorageMigrationVerification> {
    return this.service.verify(id, user.id);
  }

  @Get('migrations/:id/verifications')
  @ApiOperation({
    summary: 'List verify passes for this migration (most recent first).',
  })
  async verifications(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StorageMigrationVerification[]> {
    return this.service.listVerifications(id);
  }

  @Post('migrations/:id/delete-source')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Delete the source copies. Requires the latest verify pass to be gap-free AND the exact confirmation phrase. Returns 409 on gaps, 400 on phrase mismatch.',
  })
  async deleteSource(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteSourceDto,
  ): Promise<StorageMigration> {
    return this.service.deleteSource(id, dto, user.id);
  }

  @Get('migrations/:id/deletions')
  @ApiOperation({
    summary: 'List per-document deletion outcomes for this migration.',
  })
  async deletions(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StorageMigrationDeletion[]> {
    return this.service.listDeletions(id);
  }
}
