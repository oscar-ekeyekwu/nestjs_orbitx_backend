import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import type { Readable } from 'stream';
import {
  type GenerateUploadUrlInput,
  type PresignedUpload,
  type StorageAdapter,
} from '../storage-adapter.interface';

// ARCH-9 — preserved TTLs from the pre-STG-1 SpacesStorageService.
// PUT urls live 5 minutes so a stalled upload retry forces a fresh
// signature; GET urls live 15 minutes (NFR-S2). Receipt dispatch (E4)
// passes a longer custom TTL (7 days).
const UPLOAD_URL_TTL_SECONDS = 5 * 60;
const DEFAULT_VIEW_URL_TTL_SECONDS = 15 * 60;

export interface S3CompatibleAdapterConfig {
  providerId: string;
  providerSlug: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * STG-1 — generic S3-API adapter. Covers DigitalOcean Spaces (default),
 * Supabase Storage (`https://<project>.supabase.co/storage/v1/s3`), AWS S3,
 * Cloudflare R2 — anywhere the S3 wire protocol is honoured. The
 * `forcePathStyle: false` setting matches the pre-STG-1 Spaces wiring;
 * adapters for path-style endpoints (e.g. MinIO) can land via a separate
 * config branch when needed.
 */
export class S3CompatibleAdapter implements StorageAdapter {
  readonly providerId: string;
  readonly providerSlug: string;
  readonly bucket: string;
  private readonly endpoint: string;
  private readonly client: S3Client;

  constructor(cfg: S3CompatibleAdapterConfig) {
    this.providerId = cfg.providerId;
    this.providerSlug = cfg.providerSlug;
    this.bucket = cfg.bucket;
    this.endpoint = cfg.endpoint;

    const clientConfig: S3ClientConfig = {
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      forcePathStyle: false,
    };
    this.client = new S3Client(clientConfig);
  }

  async generateUploadUrl(
    input: GenerateUploadUrlInput,
  ): Promise<PresignedUpload> {
    const objectKey = this.buildObjectKey(input);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: input.contentType,
    });
    const uploadUrl = await getSignedUrl(this.client, command, {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    });
    return { uploadUrl, objectKey };
  }

  async generateViewUrl(
    objectKey: string,
    ttlSeconds: number = DEFAULT_VIEW_URL_TTL_SECONDS,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }

  async uploadBuffer(
    objectKey: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async objectExists(objectKey: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      const name = (err as { name?: string })?.name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') {
        return false;
      }
      throw err;
    }
  }

  async getStream(objectKey: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
    const body = result.Body;
    if (!body) {
      throw new Error(
        `No body returned for ${this.bucket}/${objectKey} from provider ${this.providerSlug}`,
      );
    }
    // The Node S3 client returns a Readable in node runtimes. The web-stream
    // branch isn't exercised here (we don't run in workers), but the cast
    // documents the assumption explicitly.
    return body as Readable;
  }

  async delete(objectKey: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      const name = (err as { name?: string })?.name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') {
        return;
      }
      throw err;
    }
  }

  canonicalUri(objectKey: string): string {
    return `${this.endpoint.replace(/\/$/, '')}/${this.bucket}/${objectKey}`;
  }

  private buildObjectKey(input: GenerateUploadUrlInput): string {
    const ext = extensionFor(input.contentType);
    return `${input.ownerType}/${input.ownerId}/${input.docType}/${randomUUID()}.${ext}`;
  }
}

/**
 * Map a MIME type to the file extension we want on the stored object key.
 * Narrow by design — C1's allowlist is the source of truth for which types
 * are accepted; this helper only runs after validation.
 */
function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'application/pdf':
      return 'pdf';
    default:
      return 'bin';
  }
}
