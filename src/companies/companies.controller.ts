import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CompaniesService } from './companies.service';
import { CompanyStatus } from './entities/company.entity';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyStatusDto } from './dto/update-company-status.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';

@ApiTags('Companies')
@ApiBearerAuth()
@Controller('companies')
@UseGuards(JwtAuthGuard)
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create a new company in pending status. The calling user becomes created_by.',
  })
  async create(@CurrentUser() user: User, @Body() dto: CreateCompanyDto) {
    // TODO (B2): require `driver_profiles.accountType = 'company_owner'`
    // on the calling user before allowing creation. DriversService doesn't
    // expose accountType yet — gating here is auth-only until B2 wires it.
    return this.companiesService.create(dto, user.id);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List companies (admin only).' })
  @ApiQuery({ name: 'status', required: false, enum: CompanyStatus })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async list(
    @Query('status') status?: CompanyStatus,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
  ) {
    return this.companiesService.findAll({ status, limit, offset });
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Get a single company. Admins see any company; other users see only ones they created.',
  })
  async findOne(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.companiesService.findByIdForUser(id, user);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary:
      'Transition company status (admin only). Writes an approval_decisions audit row in the same transaction.',
  })
  async updateStatus(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCompanyStatusDto,
  ) {
    return this.companiesService.transitionStatus(id, dto, user);
  }
}
