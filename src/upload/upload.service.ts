import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { unlink } from 'fs/promises';
import { join } from 'path';

@Injectable()
export class UploadService {
  constructor(private configService: ConfigService) {}

  async getFileUrl(filename: string, type: 'avatar' | 'document' | 'general' = 'general'): Promise<string> {
    const baseUrl = this.configService.get('APP_URL') || 'http://localhost:3000';
    const folder = type === 'avatar' ? 'avatars' : type === 'document' ? 'documents' : '';
    return `${baseUrl}/uploads/${folder ? folder + '/' : ''}${filename}`;
  }

  async deleteFile(filename: string, type: 'avatar' | 'document' | 'general' = 'general'): Promise<void> {
    try {
      const folder = type === 'avatar' ? 'avatars' : type === 'document' ? 'documents' : '';
      const filePath = join(process.cwd(), 'uploads', folder, filename);
      await unlink(filePath);
    } catch (error) {
      throw new NotFoundException('File not found');
    }
  }

  validateFileSize(file: Express.Multer.File, maxSizeInMB: number): boolean {
    const maxSizeInBytes = maxSizeInMB * 1024 * 1024;
    return file.size <= maxSizeInBytes;
  }

  validateFileType(file: Express.Multer.File, allowedTypes: string[]): boolean {
    return allowedTypes.some(type => file.mimetype.includes(type));
  }

  async processUpload(file: Express.Multer.File, type: 'avatar' | 'document' | 'general' = 'general') {
    const fileUrl = await this.getFileUrl(file.filename, type);
    return {
      filename: file.filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      url: fileUrl,
    };
  }
}
