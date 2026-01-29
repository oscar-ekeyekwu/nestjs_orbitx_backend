import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  BadRequestException,
  Delete,
  Param,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiConsumes,
  ApiBody,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { UploadService } from './upload.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  avatarUploadOptions,
  documentUploadOptions,
  multerOptions,
} from './config/multer.config';
import { ErrorCodes } from '../common/constants/error-codes';

@ApiTags('Upload')
@ApiBearerAuth()
@Controller('upload')
@UseGuards(JwtAuthGuard)
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post('avatar')
  @UseInterceptors(FileInterceptor('file', avatarUploadOptions))
  @ApiOperation({ summary: 'Upload user avatar' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async uploadAvatar(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException({
        message: 'No file provided',
        errorCode: ErrorCodes.FILE_004,
      });
    }

    return this.uploadService.processUpload(file, 'avatar');
  }

  @Post('document')
  @UseInterceptors(FileInterceptor('file', documentUploadOptions))
  @ApiOperation({ summary: 'Upload document (driver license, etc.)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async uploadDocument(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException({
        message: 'No file provided',
        errorCode: ErrorCodes.FILE_004,
      });
    }

    return this.uploadService.processUpload(file, 'document');
  }

  @Post('image')
  @UseInterceptors(FileInterceptor('file', multerOptions))
  @ApiOperation({ summary: 'Upload general image' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async uploadImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException({
        message: 'No file provided',
        errorCode: ErrorCodes.FILE_004,
      });
    }

    return this.uploadService.processUpload(file, 'general');
  }

  @Delete('avatar/:filename')
  @ApiOperation({ summary: 'Delete avatar file' })
  async deleteAvatar(@Param('filename') filename: string) {
    await this.uploadService.deleteFile(filename, 'avatar');
    return { message: 'File deleted successfully' };
  }

  @Delete('document/:filename')
  @ApiOperation({ summary: 'Delete document file' })
  async deleteDocument(@Param('filename') filename: string) {
    await this.uploadService.deleteFile(filename, 'document');
    return { message: 'File deleted successfully' };
  }

  @Delete('image/:filename')
  @ApiOperation({ summary: 'Delete image file' })
  async deleteImage(@Param('filename') filename: string) {
    await this.uploadService.deleteFile(filename, 'general');
    return { message: 'File deleted successfully' };
  }
}
