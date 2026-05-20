import type { Readable } from 'stream';

/**
 * STG-1 — provider-agnostic surface for KYC document storage. All real
 * implementations (DigitalOcean Spaces, Supabase Storage S3-API, future
 * Cloudflare R2 / GCS) live behind this interface; callers (DocumentsService,
 * ReceiptsService, migration worker) hold an instance via `StorageRegistry`,
 * never a concrete adapter class.
 *
 * `generateUploadUrl` and `generateViewUrl` shapes match the pre-STG-1
 * `SpacesStorageService` 1:1 so the C1 / ARCH-9 controller contracts stay
 * unchanged.
 */
export interface GenerateUploadUrlInput {
  ownerType: string;
  ownerId: string;
  docType: string;
  contentType: string;
}

export interface PresignedUpload {
  uploadUrl: string;
  objectKey: string;
}

export interface StorageAdapter {
  /** Provider this adapter is bound to. Stable id; used as the `documents.storage_provider_id` value. */
  readonly providerId: string;

  /** Display slug for logs + audit (e.g. `spaces-default`, `supabase-eu-central`). */
  readonly providerSlug: string;

  /** Bucket this adapter writes into. Used by `canonicalUri` + diagnostics. */
  readonly bucket: string;

  generateUploadUrl(input: GenerateUploadUrlInput): Promise<PresignedUpload>;
  generateViewUrl(objectKey: string, ttlSeconds?: number): Promise<string>;
  uploadBuffer(
    objectKey: string,
    body: Buffer,
    contentType: string,
  ): Promise<void>;
  objectExists(objectKey: string): Promise<boolean>;
  /** Stream the object body. Used by the STG-4 cross-provider migration worker. */
  getStream(objectKey: string): Promise<Readable>;
  /** Delete a single object. Idempotent — a missing key resolves without error. */
  delete(objectKey: string): Promise<void>;
  /** `endpoint/bucket/key` reference persisted in `documents.fileUrl`. The URL is never used directly — reads always go through `generateViewUrl`. */
  canonicalUri(objectKey: string): string;
}
