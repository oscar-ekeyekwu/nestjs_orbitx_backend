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
import { Throttle } from '@nestjs/throttler';
import { DocumentsService } from './documents.service';
import { GetUploadUrlDto } from './dto/get-upload-url.dto';
import { CreateDocumentDto } from './dto/create-document.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@ApiTags('Documents')
@ApiBearerAuth()
@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('upload-url')
  @HttpCode(HttpStatus.OK)
  // NFR-S6 / ARCH-11 follow-up: 10 upload-url requests per minute per
  // IP. Tight to discourage script-driven URL minting; loose enough
  // for a real user retrying a stalled upload.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary:
      'Issue a 5-minute presigned PUT URL for a KYC document upload (ARCH-9).',
  })
  async getUploadUrl(@CurrentUser() user: User, @Body() dto: GetUploadUrlDto) {
    return this.documentsService.generateUploadUrl(dto, user);
  }

  @Post()
  // C1: persist the Document row only after HEAD-verifying that the
  // client actually completed the upload. Tighter throttle than the
  // upload-url issuer because each call hits Spaces.
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({
    summary:
      'Persist the Document metadata row after a successful upload. HEAD-verifies the object exists in Spaces before writing.',
  })
  async createDocument(
    @CurrentUser() user: User,
    @Body() dto: CreateDocumentDto,
  ) {
    return this.documentsService.createDocument(dto, user);
  }

  @Get(':id/view-url')
  @ApiOperation({
    summary:
      'Issue a 15-minute presigned GET URL for an existing document (ARCH-9 + NFR-S2).',
  })
  async getViewUrl(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.documentsService.generateViewUrl(id, user);
  }
}
