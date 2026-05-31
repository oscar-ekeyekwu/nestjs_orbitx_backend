import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import type { User } from '../users/entities/user.entity';
import { CreatePaymentProviderDto } from './dto/create-payment-provider.dto';
import { UpdatePaymentProviderDto } from './dto/update-payment-provider.dto';
import { PaymentProvidersService } from './payment-providers.service';

/**
 * PAY-1 — admin-only CRUD for payment providers. Surface mirrors the
 * STG-2 storage admin endpoints — list / create / update / delete /
 * activate / test. Plaintext secrets never leave the controller; the
 * service handles encryption + masking on every response.
 */
@ApiTags('admin/payment-providers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('payment-providers')
export class PaymentProvidersController {
  constructor(private readonly service: PaymentProvidersService) {}

  @Get()
  @ApiOperation({
    summary:
      'List every payment provider, masked secrets included. The one whose id matches system_configs.payment.activeProviderId is flagged isActive=true.',
  })
  list() {
    return this.service.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single provider by id.' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @ApiOperation({
    summary:
      'Create a new payment provider row. Encrypts the plaintext secretKey before persist.',
  })
  create(@CurrentUser() user: User, @Body() dto: CreatePaymentProviderDto) {
    return this.service.create(dto, user.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Partial update. Omit secretKey / webhookSecret to keep the existing ciphers. Pass webhookSecret="" to clear it.',
  })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentProviderDto,
  ) {
    return this.service.update(id, dto, user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Delete a provider. The currently-active provider cannot be deleted; activate a different one first.',
  })
  async remove(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.service.remove(id, user.id);
  }

  @Post(':id/activate')
  @ApiOperation({
    summary:
      'Point system_configs.payment.activeProviderId at this row. New checkouts use these credentials immediately.',
  })
  activate(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.activate(id, user.id);
  }

  @Post(':id/test')
  @ApiOperation({
    summary:
      'Probe the gateway with the stored credentials. Returns { ok, latencyMs } on success or { ok: false, error } on failure.',
  })
  test(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.test(id);
  }
}
