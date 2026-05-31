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

// DR-NEW — expiry is required ONLY for driver-bound permits + identity
// docs whose issuing body publishes a hard expiry. The v1 spec
// explicitly drops the expiry requirement for INSURANCE and ROADWORTHY
// (admins still see the upload date and can replace stale docs as
// part of normal review, but the customer mobile no longer blocks the
// upload form on an "expiry date" input the driver often doesn't have
// in hand). NIN / Passport / Voter's Card / Vehicle Registration /
// Vehicle License / Vehicle Photo / CAC / TIN / SELFIE / GOV_ID are
// non-expiring identity / ownership artefacts in this catalogue.
export const EXPIRY_REQUIRED_DOCUMENT_TYPES: ReadonlySet<DocumentType> =
  new Set([
    DocumentType.DRIVERS_LICENSE,
    DocumentType.LASAA_PERMIT,
    DocumentType.NIPOST_LICENSE,
  ]);

export function requiresExpiry(type: DocumentType): boolean {
  return EXPIRY_REQUIRED_DOCUMENT_TYPES.has(type);
}

/**
 * C4 — document types that, when expired, trigger the owner-entity
 * suspension state transition. These are the regulator-issued
 * time-bound docs whose absence makes continued operation a real
 * compliance hazard (PRD DR-L2 / F1-3 / P2):
 *
 *   driver_license / nin     → driver
 *   vehicle_registration     → vehicle
 *   insurance / roadworthy   → vehicle
 *   lasaa_permit             → vehicle
 *   nipost_license           → driver (commercial courier)
 *   cac_certificate          → company
 *
 * NIN and CAC do not appear in EXPIRY_REQUIRED_DOCUMENT_TYPES (they
 * don't expire by issuer), so they cannot reach the suspension path
 * via the expiry cron. They're included here for completeness so a
 * future "missing required doc" sweep can use the same constant.
 */
export const SUSPENSION_TRIGGER_DOC_TYPES: ReadonlySet<DocumentType> = new Set([
  DocumentType.DRIVERS_LICENSE,
  DocumentType.INSURANCE,
  DocumentType.ROADWORTHY,
  DocumentType.LASAA_PERMIT,
  DocumentType.NIPOST_LICENSE,
  DocumentType.VEHICLE_REGISTRATION,
  DocumentType.CAC_CERTIFICATE,
]);

export function suspensionTriggerFor(type: DocumentType): boolean {
  return SUSPENSION_TRIGGER_DOC_TYPES.has(type);
}
