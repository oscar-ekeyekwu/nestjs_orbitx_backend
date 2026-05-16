import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotificationTemplateService } from './notification-template.service';
import { NotificationType } from './entities/notification.entity';
import { UpdateNotificationTemplateDto } from './dto/update-notification-template.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';

@ApiTags('Notification Templates')
@ApiBearerAuth()
@Controller('admin/notification-templates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class NotificationTemplateAdminController {
  constructor(private readonly service: NotificationTemplateService) {}

  @Get()
  @ApiOperation({
    summary: 'List all notification templates (Admin only)',
  })
  async findAll() {
    return this.service.findAll();
  }

  @Patch(':eventType')
  @ApiOperation({
    summary: 'Update a notification template (Admin only)',
  })
  async update(
    @Param('eventType', new ParseEnumPipe(NotificationType))
    eventType: NotificationType,
    @Body() dto: UpdateNotificationTemplateDto,
  ) {
    return this.service.update(eventType, dto);
  }
}
