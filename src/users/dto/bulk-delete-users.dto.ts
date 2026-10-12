import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BulkDeleteUsersDto {
  @ApiProperty({
    type: [String],
    description: 'User ids to delete (customers / drivers only). Max 100.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  ids: string[];
}
