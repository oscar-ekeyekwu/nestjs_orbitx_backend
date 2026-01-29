import {
  Controller,
  Get,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SystemConfigService } from './config.service';
import { UpdateConfigDto } from './dto/update-config.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';

@ApiTags('Configuration')
@ApiBearerAuth()
@Controller('config')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ConfigController {
  constructor(private readonly configService: SystemConfigService) {}

  @Get()
  @ApiOperation({ summary: 'Get all system configurations' })
  async getAll() {
    return this.configService.getAll();
  }

  @Get(':key')
  @ApiOperation({ summary: 'Get a specific configuration by key' })
  async getByKey(@Param('key') key: string) {
    return this.configService.get(key);
  }

  @Put(':key')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a configuration (Admin only)' })
  async update(@Param('key') key: string, @Body() updateDto: UpdateConfigDto) {
    return this.configService.update(key, { ...updateDto, key });
  }

  @Put()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Bulk update configurations (Admin only)' })
  async bulkUpdate(@Body() updates: UpdateConfigDto[]) {
    return this.configService.bulkUpdate(updates);
  }

  @Delete(':key')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a configuration (Admin only)' })
  async delete(@Param('key') key: string) {
    await this.configService.delete(key);
  }
}
