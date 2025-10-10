import { IsEmail, IsString } from 'class-validator';

export class GoogleAuthDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}
