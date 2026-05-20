import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * STG-5 — body for `POST /admin/storage/migrations/:id/delete-source`.
 * The operator must type a phrase matching exactly
 *   `DELETE <N> documents from <source-slug>`
 * where `<N>` is the migration's migratedCount and `<source-slug>` is
 * the source provider's slug. The backend computes the expected
 * phrase server-side and compares with strict equality — typos fail
 * the call so the destructive action cannot be triggered by a stale
 * cached form or a copy-paste mistake.
 */
export class DeleteSourceDto {
  @ApiProperty({
    example: 'DELETE 42 documents from spaces-default',
    description:
      'Must equal "DELETE <migratedCount> documents from <sourceSlug>" exactly.',
  })
  @IsString()
  @IsNotEmpty()
  confirm: string;
}
