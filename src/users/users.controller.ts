import {
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Delete,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from './entities/user.entity';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserRole } from '../common/enums/user-role.enum';
import { GetUsersQueryDto } from './dto/get-users-query.dto';
import { BulkDeleteUsersDto } from './dto/bulk-delete-users.dto';
import { UserPurgeService } from './user-purge.service';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly purge: UserPurgeService,
  ) {}

  /**
   * Get all users (for admins)
   */
  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get all users (Admin only)' })
  async findAll(@Query() query: GetUsersQueryDto) {
    return this.usersService.findAll(query);
  }

  /**
   * Get current user's profile
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getProfile(@CurrentUser() user: User): Promise<User | null> {
    return this.usersService.findById(user.id);
  }

  /**
   * Get user by ID
   */
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async findOne(@Param('id') id: string): Promise<User | null> {
    return this.usersService.findById(id);
  }

  /**
   * Update current user's profile
   */
  @Patch('me')
  @UseGuards(JwtAuthGuard)
  async updateProfile(
    @CurrentUser() user: User,
    @Body() updateUserDto: UpdateUserDto,
  ): Promise<User> {
    return this.usersService.update(user.id, updateUserDto);
  }

  /**
   * Update a specific user (admin use)
   */
  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a user (Admin only)' })
  async update(
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
  ): Promise<User> {
    return this.usersService.update(id, updateUserDto);
  }

  /**
   * Permanently delete a customer / driver and every related record
   * (orders, wallet, documents, tokens, ...). Admin only. Not the NDPA
   * soft-delete — see UserPurgeService.
   */
  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Permanently delete a user and all related records (Admin only)',
  })
  async remove(@Param('id') id: string, @CurrentUser() admin: User) {
    return this.purge.purge(id, admin);
  }

  /**
   * Bulk variant of DELETE /users/:id. Each id is purged in its own
   * transaction so one blocked account does not roll back the rest.
   */
  @Post('bulk-delete')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Permanently delete several users and their related records (Admin only)',
  })
  async bulkRemove(
    @Body() dto: BulkDeleteUsersDto,
    @CurrentUser() admin: User,
  ) {
    return this.purge.purgeMany(dto.ids, admin);
  }
}
