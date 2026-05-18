import {
  Body,
  Controller,
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
import { CompanyMembershipsService } from './company-memberships.service';
import { CreateCompanyMembershipDto } from './dto/create-company-membership.dto';
import { UpdateCompanyMembershipStatusDto } from './dto/update-company-membership-status.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@ApiTags('CompanyMemberships')
@ApiBearerAuth()
@Controller('companies/:companyId/memberships')
@UseGuards(JwtAuthGuard)
export class CompanyMembershipsController {
  constructor(private readonly membershipsService: CompanyMembershipsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Invite a driver to a company. Membership lands as pending until updateStatus flips it.',
  })
  async create(
    @CurrentUser() user: User,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: CreateCompanyMembershipDto,
  ) {
    return this.membershipsService.create(companyId, dto, user);
  }

  @Get()
  @ApiOperation({
    summary: 'List a company`s memberships. Owner or admin only.',
  })
  async list(
    @CurrentUser() user: User,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ) {
    return this.membershipsService.findAllForCompany(companyId, user);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Transition a membership status. Legal: pending → approved | removed, approved → removed.',
  })
  async updateStatus(
    @CurrentUser() user: User,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCompanyMembershipStatusDto,
  ) {
    return this.membershipsService.updateStatus(companyId, id, dto, user);
  }
}
