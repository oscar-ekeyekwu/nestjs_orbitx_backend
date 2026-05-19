import { diskStorage } from 'multer';
import { extname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { BadRequestException } from '@nestjs/common';
import { ErrorCodes } from '../../common/constants/error-codes';
import type { Request } from 'express';

type DestinationCallback = (error: Error | null, destination: string) => void;
type FilenameCallback = (error: Error | null, filename: string) => void;
type FileFilterCallback = (error: Error | null, acceptFile: boolean) => void;

const FILE_SIZE_5MB = 5 * 1024 * 1024;
const FILE_SIZE_2MB = 2 * 1024 * 1024;
const FILE_SIZE_10MB = 10 * 1024 * 1024;

function randomToken(): string {
  return Array(32)
    .fill(null)
    .map(() => Math.round(Math.random() * 16).toString(16))
    .join('');
}

function makeImageFileFilter(mimePattern: RegExp, message: string) {
  return (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    if (mimePattern.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new BadRequestException({
          message,
          errorCode: ErrorCodes.FILE_001,
        }),
        false,
      );
    }
  };
}

function makeDestination(uploadPath: string) {
  return (
    _req: Request,
    _file: Express.Multer.File,
    cb: DestinationCallback,
  ) => {
    if (!existsSync(uploadPath)) {
      mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  };
}

function makeFilename(prefix = '') {
  return (_req: Request, file: Express.Multer.File, cb: FilenameCallback) => {
    cb(null, `${prefix}${randomToken()}${extname(file.originalname)}`);
  };
}

export const multerConfig = {
  limits: {
    fileSize: FILE_SIZE_5MB,
  },
};

export const multerOptions = {
  limits: {
    fileSize: FILE_SIZE_5MB,
  },
  fileFilter: makeImageFileFilter(
    /\/(jpg|jpeg|png|gif|webp)$/,
    'Invalid file type. Only image files are allowed.',
  ),
  storage: diskStorage({
    destination: makeDestination('./uploads'),
    filename: makeFilename(),
  }),
};

export const avatarUploadOptions = {
  limits: {
    fileSize: FILE_SIZE_2MB,
  },
  fileFilter: makeImageFileFilter(
    /\/(jpg|jpeg|png|webp)$/,
    'Invalid file type. Only JPG, PNG, and WebP are allowed for avatars.',
  ),
  storage: diskStorage({
    destination: makeDestination('./uploads/avatars'),
    filename: makeFilename('avatar-'),
  }),
};

export const documentUploadOptions = {
  limits: {
    fileSize: FILE_SIZE_10MB,
  },
  fileFilter: makeImageFileFilter(
    /\/(jpg|jpeg|png|pdf)$/,
    'Invalid file type. Only JPG, PNG, and PDF are allowed for documents.',
  ),
  storage: diskStorage({
    destination: makeDestination('./uploads/documents'),
    filename: makeFilename('doc-'),
  }),
};
