import { IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ReorderFaqsDto {
  @ApiProperty({ type: [String], description: 'Ordered array of FAQ IDs' })
  @IsArray()
  @IsString({ each: true })
  ids: string[];
}
