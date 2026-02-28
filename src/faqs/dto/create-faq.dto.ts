import { IsString, IsBoolean, IsOptional, IsInt, Min, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateFaqDto {
  @ApiProperty({ example: 'How do I track my order?' })
  @IsString()
  @MinLength(5)
  @MaxLength(200)
  question: string;

  @ApiProperty({ example: 'You can track your order from the Order History screen.' })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  answer: string;

  @ApiProperty({ example: 'Orders', enum: ['General', 'Orders', 'Payments', 'Drivers', 'Account'] })
  @IsString()
  category: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
