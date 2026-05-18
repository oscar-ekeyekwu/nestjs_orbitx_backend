import { DocumentType } from './entities/document.entity';

// C1 — MIME allowlist for documents that land in DigitalOcean Spaces.
// Kept narrow because every entry expands the attack surface for the
// presigned-upload contract (S3 signs the ContentType, but the
// downstream document-rendering paths in the admin console still have
// to handle whatever lands here).
//
// Add new types ONLY when a real PRD-cited document requires it (e.g.
// a regulator-issued cert that's only distributed as a Word file would
// need a deliberate review).
export const ALLOWED_DOCUMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;

export type AllowedDocumentMimeType =
  (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];

export function isAllowedDocumentMimeType(
  value: string,
): value is AllowedDocumentMimeType {
  return (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(value);
}

// C2 — document types whose AC requires an expiry date on create. The
// spec lists "license, insurance, roadworthy" explicitly; LASAA permit
// and NIPOST license also expire and are bundled in (regulator-issued
// time-bound documents). NIN / CAC / TIN / selfie / gov_id are non-
// expiring identity artefacts.
export const EXPIRY_REQUIRED_DOCUMENT_TYPES: ReadonlySet<DocumentType> =
  new Set([
    DocumentType.DRIVERS_LICENSE,
    DocumentType.INSURANCE,
    DocumentType.ROADWORTHY,
    DocumentType.LASAA_PERMIT,
    DocumentType.NIPOST_LICENSE,
  ]);

export function requiresExpiry(type: DocumentType): boolean {
  return EXPIRY_REQUIRED_DOCUMENT_TYPES.has(type);
}
