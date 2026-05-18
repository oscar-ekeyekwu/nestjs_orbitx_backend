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
