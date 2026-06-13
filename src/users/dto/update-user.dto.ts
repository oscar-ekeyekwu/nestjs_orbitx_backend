import {
  IsOptional,
  IsEmail,
  IsString,
  IsBoolean,
  MaxLength,
} from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  first_name?: string;

  @IsOptional()
  @IsString()
  last_name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  /**
   * URL of the profile picture stored in the platform's image
   * adapter. The mobile client uploads to POST /upload/image first,
   * then PATCH /users/me with the returned URL. Empty string clears
   * the existing avatar.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  avatar?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
