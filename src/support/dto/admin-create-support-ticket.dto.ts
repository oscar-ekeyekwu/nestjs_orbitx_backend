import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CreateSupportTicketDto } from './create-support-ticket.dto';

export class AdminCreateSupportTicketDto extends CreateSupportTicketDto {
  @ApiProperty({ description: 'The user this ticket is filed on behalf of' })
  @IsUUID()
  userId: string;
}
