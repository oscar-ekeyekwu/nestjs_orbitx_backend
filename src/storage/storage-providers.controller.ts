import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { CreateStorageProviderDto } from './dto/create-storage-provider.dto';
import { UpdateStorageProviderDto } from './dto/update-storage-provider.dto';
import {
  StorageProvidersService,
  type StorageProviderTestResult,
  type StorageProviderView,
} from './storage-providers.service';

@ApiTags('Admin · Storage Providers')
@ApiBearerAuth()
@Controller('admin/storage/providers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class StorageProvidersController {
  constructor(private readonly service: StorageProvidersService) {}

  @Get()
  @ApiOperation({ summary: 'List storage providers (admin only).' })
  async list(): Promise<StorageProviderView[]> {
    return this.service.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single storage provider.' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StorageProviderView> {
    return this.service.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Register a new storage provider. Encrypts the secret access key with STORAGE_KEK before persisting.',
  })
  async create(
    @CurrentUser() user: User,
    @Body() dto: CreateStorageProviderDto,
  ): Promise<StorageProviderView> {
    return this.service.create(dto, user.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update a storage provider. Slug is immutable post-create; supplying it returns 400.',
  })
  async update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStorageProviderDto,
  ): Promise<StorageProviderView> {
    return this.service.update(id, dto, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete a storage provider. Refuses with 409 if the provider is active or has referencing documents.',
  })
  async remove(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.service.remove(id, user.id);
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Validate the credentials by HEADing a sentinel key. Returns { ok, latencyMs } or { ok: false, error }.',
  })
  async test(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StorageProviderTestResult> {
    return this.service.test(id);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Make this provider the destination for new uploads. Atomically updates system_configs and writes an audit row.',
  })
  async activate(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StorageProviderView> {
    return this.service.activate(id, user.id);
  }
}
