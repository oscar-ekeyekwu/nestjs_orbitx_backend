import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

// ARCH-9 — TTLs per architecture impl §4 / NFR-S2:
//   - PUT urls live 5 minutes so a stalled upload retry forces a fresh
//     signature (less risk of leaked signed urls being usable).
//   - GET urls live 15 minutes so an admin can scroll through 5–10
//     documents on a slow link without re-fetching urls every screen.
const UPLOAD_URL_TTL_SECONDS = 5 * 60;
const VIEW_URL_TTL_SECONDS = 15 * 60;

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

/**
 * Thin wrapper over @aws-sdk/client-s3 configured for DigitalOcean
 * Spaces (NYC3 region). Holds a single S3Client instance, since
 * presigning is cheap but client construction isn't.
 *
 * Bucket policy is private — no public reads, ever. Both PUT and GET
 * require a presigned url; clients never get bucket-level credentials.
 *
 * NFR-C2 residency gap: Spaces NYC3 is in the US. Nigerian regulators
 * (NDPA) prefer data residency. v1 ships against NYC3 with explicit
 * legal sign-off; v1.1 migrates to a Lagos / Cape Town region once the
 * provider list firms up. Documented in deploy/README.md.
 */
@Injectable()
export class SpacesStorageService {
  private readonly logger = new Logger(SpacesStorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const endpoint =
      this.config.get<string>('SPACES_ENDPOINT') ??
      'https://nyc3.digitaloceanspaces.com';
    const region = this.config.get<string>('SPACES_REGION') ?? 'nyc3';
    const accessKeyId = this.config.get<string>('SPACES_KEY') ?? '';
    const secretAccessKey = this.config.get<string>('SPACES_SECRET') ?? '';
    this.bucket = this.config.get<string>('SPACES_BUCKET') ?? 'orbit-kyc-v1';

    if (!accessKeyId || !secretAccessKey) {
      // Don't crash boot — local dev + CI run without real credentials.
      // Presign calls will fail loudly when they actually hit the SDK.
      this.logger.warn(
        'SPACES_KEY / SPACES_SECRET missing — presigned uploads will fail until configured.',
      );
    }

    const clientConfig: S3ClientConfig = {
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: false,
    };
    this.client = new S3Client(clientConfig);
  }

  /**
   * Build a deterministic object key:
   *   `<ownerType>/<ownerId>/<docType>/<uuid>.<ext>`
   *
   * Putting the owner facets in the prefix keeps prefix-based listing
   * + future bucket policies sane (e.g. "list all docs for user X" is
   * a single prefix scan).
   */
  private buildObjectKey(input: GenerateUploadUrlInput): string {
    const ext = extensionFor(input.contentType);
    return `${input.ownerType}/${input.ownerId}/${input.docType}/${randomUUID()}.${ext}`;
  }

  /**
   * Issues a presigned PUT url scoped to the supplied content type.
   * The client must send the SAME `Content-Type` header on the PUT or
   * S3 will reject the signature.
   */
  async generateUploadUrl(
    input: GenerateUploadUrlInput,
  ): Promise<PresignedUpload> {
    const objectKey = this.buildObjectKey(input);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: input.contentType,
      // ACL is intentionally NOT 'public-read' — the bucket policy
      // denies public reads regardless, but never assume.
    });
    const uploadUrl = await getSignedUrl(this.client, command, {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    });
    return { uploadUrl, objectKey };
  }

  /**
   * Build the canonical `endpoint/bucket/key` reference for an object.
   * Persisted in `documents.fileUrl` purely as a stable, human-readable
   * pointer — the bucket is private, so the URL is never used directly;
   * actual reads always go through {@link generateViewUrl}.
   */
  getCanonicalUri(objectKey: string): string {
    const endpoint =
      this.config.get<string>('SPACES_ENDPOINT') ??
      'https://nyc3.digitaloceanspaces.com';
    return `${endpoint.replace(/\/$/, '')}/${this.bucket}/${objectKey}`;
  }

  /**
   * Issues a presigned GET url. Defaults to the 15-minute KYC TTL
   * (NFR-S2); callers like E4 receipts pass a longer custom TTL since
   * the link is dispatched via SMS / email and the recipient may not
   * tap it for hours.
   */
  async generateViewUrl(
    objectKey: string,
    ttlSeconds: number = VIEW_URL_TTL_SECONDS,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: ttlSeconds,
    });
  }

  /**
   * Direct server-side upload. Used by E4 receipt generation where the
   * server renders the file (no client roundtrip) and stores it under a
   * deterministic, non-uuid'd key (e.g. `receipts/<orderId>.pdf`).
   */
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

  /**
   * HEAD the bucket — returns true if the object exists, false on
   * 404 / NoSuchKey. Used by C1 to verify the client actually
   * uploaded before persisting the metadata row.
   */
  async objectExists(objectKey: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
        }),
      );
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      const name = (err as { name?: string })?.name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') {
        return false;
      }
      // Anything else (5xx, auth) is a real error — let the caller
      // bubble it.
      throw err;
    }
  }
}

/**
 * Map a MIME type to the file extension we want on the stored object
 * key. Kept narrow — C1's allowlist is the source of truth for which
 * types are accepted; this helper is only consulted for types that
 * passed validation.
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
      // Fallback for any future allow-listed type the helper hasn't
      // learned yet — `bin` is a safe neutral choice that doesn't
      // pretend to be a known format.
      return 'bin';
  }
}
