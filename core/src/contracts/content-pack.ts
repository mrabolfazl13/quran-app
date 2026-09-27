/**
 * Content pack contract. A pack is an immutable, verifiable bundle of content
 * that ships inside the app. Nothing is displayed before its checksum passes.
 */

export const CONTENT_PACK_SCHEMA_VERSION = 1;

export type PackKind =
  | 'quran-core'
  | 'translation'
  | 'tafsir'
  | 'word-data'
  | 'concepts'
  | 'linguistic'
  | 'audio'
  | 'educational';

export type LicenseStatus = 'clear' | 'attribution-required' | 'unresolved';

export interface ContentLicense {
  /** SPDX id when known, otherwise a short human description. */
  spdx: string | null;
  name: string;
  url: string | null;
  status: LicenseStatus;
  /** Why the status was chosen; required when status is not `clear`. */
  notes: string;
}

export interface ContentAttribution {
  publisher: string;
  work: string;
  edition: string | null;
  sourceUrl: string;
  retrievedAt: string;
  creditLine: string;
}

export interface ContentPackManifest {
  id: string;
  kind: PackKind;
  version: string;
  schemaVersion: number;
  language: 'ar' | 'fa' | 'en' | 'und';
  title: string;
  source: string;
  license: ContentLicense;
  attribution: ContentAttribution;
  /** sha256 hex of the payload file, computed at build time. */
  checksum: string;
  /** Byte length of the payload, guards against truncated copies. */
  payloadBytes: number;
  /** Rows in the payload; used by integrity checks. */
  recordCount: number;
  /** Expected range, encoded so validation can assert counts without parsing. */
  coverage: { chapters: number[]; verseKeysFrom?: string; verseKeysTo?: string };
  generatedAt: string;
  generator: string;
}

export interface ContentPackFile<T> {
  manifest: ContentPackManifest;
  records: T[];
}

export interface PackIndex {
  schemaVersion: number;
  builtAt: string;
  packs: ContentPackManifest[];
}
