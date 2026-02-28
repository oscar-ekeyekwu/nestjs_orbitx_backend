import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { FaqsService } from './faqs.service';
import { CreateFaqDto } from './dto/create-faq.dto';
import { UpdateFaqDto } from './dto/update-faq.dto';
import { ReorderFaqsDto } from './dto/reorder-faqs.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';

@ApiTags('FAQs')
@Controller('faqs')
export class FaqsController {
  constructor(private readonly faqsService: FaqsService) {}

  // ─── Public endpoints ─────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List all active FAQs (public)' })
  @ApiQuery({ name: 'all', required: false, type: Boolean, description: 'Include inactive FAQs (admin use)' })
  findAll(@Query('all') all?: string) {
    // Only expose inactive FAQs when explicitly requested (admin frontend passes ?all)
    const onlyActive = all !== 'true';
    return this.faqsService.findAll(onlyActive);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single FAQ by ID (public)' })
  findOne(@Param('id') id: string) {
    return this.faqsService.findOne(id);
  }

  // ─── Admin endpoints ───────────────────────────────────────────────────────

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a FAQ (admin only)' })
  create(@Body() dto: CreateFaqDto) {
    return this.faqsService.create(dto);
  }

  @Post('reorder')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reorder FAQs (admin only)' })
  reorder(@Body() dto: ReorderFaqsDto) {
    return this.faqsService.reorder(dto.ids);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a FAQ (admin only)' })
  update(@Param('id') id: string, @Body() dto: UpdateFaqDto) {
    return this.faqsService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a FAQ (admin only)' })
  remove(@Param('id') id: string) {
    return this.faqsService.remove(id);
  }
}
