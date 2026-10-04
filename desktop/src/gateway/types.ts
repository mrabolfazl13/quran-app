/**
 * DataGateway — the single boundary between the UI and storage.
 *
 * Two implementations exist and nothing above this file may know which one is
 * live:
 *   • `TauriGateway`  — @tauri-apps/plugin-sql (SQLite in the Rust layer) and
 *     argument-validated native commands for pack/backup files. This is the
 *     shipped path.
 *   • `DevGateway`    — in-memory tables for `vite dev` in a browser. It loads
 *     the *same* pack files from `/content`, runs the *same* verification and
 *     record mapping code (`src/content/*`), and is always announced in the UI
 *     with the "dev shell" badge.
 *
 * Rows are typed with `@quran/core` contracts. Array indexes are never IDs.
 */
import type {
  AnchorWord,
  Ayah,
  AyahRelation,
  AyahWord,
  BackupEnvelope,
  Bookmark,
  Concept,
  ConceptAyahLink,
  ConceptRelation,
  ConfusionGroup,
  ContentAttribution,
  HifzItem,
  HifzItemStatus,
  HifzSegment,
  HifzSession,
  HifzTransition,
  LicenseStatus,
  MigrationResult,
  Note,
  PackKind,
  ReadingHistoryEntry,
  ReadingPosition,
  RecallAttempt,
  SimilarAyahPair,
  Surah,
  TafsirPassage,
  VerseKey,
} from '@quran/core';

export type { Bookmark, HifzItem, Note };

export type GatewayMode = 'tauri' | 'web' | 'dev';

/**
 * What the shell is, as an id rather than a sentence. A gateway runs below the
 * language boundary and has no `tr`; when it spoke English directly, that
 * English landed in the middle of the Persian interface (defect 7 was the same
 * bug in the review scheduler, and the fix is the same shape: emit a key and
 * params, translate at the screen).
 */
export type GatewayLabelId = 'tauri-sqlite' | 'web-http' | 'dev-shell';

/**
 * Where the user's rows live. `databasePath` carries the real path when there is
 * one, so this describes the storage kind and nothing else.
 */
export type GatewayStoreId =
  | 'sqlite-file'
  | 'browser-store-plus-origin-content'
  | 'browser-store-plus-memory-content';

/** Why the search backend is the one it is, shown on Data health and search. */
export type SearchNoteId =
  | 'fts5-order-plus-substring'
  | 'fts5-unavailable'
  | 'memory-index-dev'
  | 'memory-index-web';

/**
 * The search paths a gateway can report. `core-engine` was removed on
 * 2026-09-28: `CoreEngineSearchService` existed but no gateway constructed it,
 * so nothing ever answered under that id.
 *
 * `memory-index` is what `dev-index` used to be called — the browser build was
 * only ever a dev shell then, so the id read as "not the real thing". The web
 * deliverable runs the same in-memory index on a shipped path, so the name says
 * where the index lives, not which shell opened it.
 */
export type SearchBackend = 'sqlite-fts5' | 'like' | 'memory-index';

export interface GatewayInfo {
  mode: GatewayMode;
  /** Which shell this is, as an id the UI translates. */
  labelId: GatewayLabelId;
  /** What holds the user's rows, as an id the UI translates. */
  storeId: GatewayStoreId;
  /** The SQLite file path, when there is one. Data, never prose. */
  databasePath: string | null;
  contentRoot: string | null;
  schemaVersion: number;
  searchBackend: SearchBackend;
  /**
   * False only for the throwaway dev shell. The web build is a shipped path:
   * what it stores is what the user gets, so it must not wear a dev badge.
   */
  isShippedPath: boolean;
}

export interface PackRow {
  id: string;
  kind: PackKind;
  version: string;
  schemaVersion: number;
  language: string;
  title: string;
  source: string;
  licenseName: string;
  licenseSpdx: string | null;
  licenseStatus: LicenseStatus;
  licenseNotes: string;
  attribution: ContentAttribution;
  checksum: string;
  payloadBytes: number;
  recordCount: number;
  importedAt: string;
}

export interface AyahRow extends Ayah {
  wordCount: number;
  normalizedHash: string;
}

export interface AyahWordRow extends AyahWord {
  normalized: string;
}

export interface TranslationRow {
  verseKey: VerseKey;
  packId: string;
  text: string;
}

export interface TafsirRow extends TafsirPassage {}

export interface AudioTrackRow {
  id: string;
  verseKey: VerseKey | null;
  chapter: number | null;
  reciter: string;
  filePath: string;
  durationMs: number | null;
  licenseStatus: LicenseStatus;
}

/**
 * One row of `ayah_search`. Every field is `matchKey` text — a *matching* form,
 * never display text — so the query and the stored index agree for Arabic,
 * Persian and English alike. `translationFa` carries all bundled Persian packs,
 * joined in pack-id order. Display comes from `ayah` and `translation`.
 */
export interface SearchDocRow {
  verseKey: VerseKey;
  arabic: string;
  translationEn: string;
  translationFa: string;
}

/** Everything a verified import writes, in one atomic step. */
export interface ContentPlan {
  packs: PackRow[];
  surahs: Surah[];
  ayahs: AyahRow[];
  words: AyahWordRow[];
  translations: TranslationRow[];
  tafsirs: TafsirRow[];
  similar: SimilarAyahPair[];
  relations: AyahRelation[];
  concepts: Concept[];
  conceptAyah: ConceptAyahLink[];
  conceptRelations: ConceptRelation[];
  audio: AudioTrackRow[];
  searchDocs: SearchDocRow[];
}

export function emptyPlan(): ContentPlan {
  return {
    packs: [],
    surahs: [],
    ayahs: [],
    words: [],
    translations: [],
    tafsirs: [],
    similar: [],
    relations: [],
    concepts: [],
    conceptAyah: [],
    conceptRelations: [],
    audio: [],
    searchDocs: [],
  };
}

export type ImportStage =
  | 'index'
  | 'checksum'
  | 'payload-bytes'
  | 'record-count'
  | 'record-shape'
  | 'integrity'
  | 'write'
  | 'schema'
  | 'unavailable';

export interface ImportIssue {
  stage: ImportStage;
  packId?: string;
  message: string;
  detail?: string;
}

export interface ImportPackOutcome {
  packId: string;
  kind: PackKind;
  title: string;
  recordsRead: number;
  recordsApplied: number;
  /** Recomputed over the payload file, compared to the manifest digest. */
  checksum: string;
  checksumOk: boolean;
  licenseStatus: LicenseStatus;
}

export interface ImportCounts {
  surahs: number;
  ayahs: number;
  words: number;
  translations: number;
  tafsirs: number;
  similar: number;
  relations: number;
  concepts: number;
  audio: number;
}

export type ImportStatus = 'success' | 'failed' | 'no-packs';

export interface ImportReport {
  at: string;
  status: ImportStatus;
  durationMs: number;
  packs: ImportPackOutcome[];
  counts: ImportCounts;
  issue?: ImportIssue;
  /** Non-fatal notes, e.g. a pack kind the importer has no table mapping for. */
  warnings: ImportIssue[];
}

export interface ContentCounts extends ImportCounts {
  packs: number;
  bookmarks: number;
  notes: number;
  hifzItems: number;
  recallAttempts: number;
  confusionGroups: number;
}

export interface TranslationOption {
  packId: string;
  title: string;
  language: 'en' | 'fa' | 'ar' | 'und';
  licenseStatus: LicenseStatus;
  /** Rows actually present — a pack can be installed and still incomplete. */
  coverage: number;
}

export interface JuzSummary {
  juz: number;
  firstVerseKey: VerseKey;
  lastVerseKey: VerseKey;
  pageFrom: number;
  pageTo: number;
  ayahCount: number;
}

export interface SearchHit {
  verseKey: VerseKey;
  chapter: number;
  verse: number;
  page: number;
  /** Arabic text is always available for a hit; it is the anchor of the index. */
  textUthmani: string;
  field: 'arabic' | 'translation-en' | 'translation-fa';
  /** Excerpt with the match, never the whole ayah for long passages. */
  excerpt: string;
  rank: number;
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to one translation column; undefined searches Arabic + all. */
  field?: SearchHit['field'];
}

export interface HomeStats {
  /** Continue Reading — the stored position, or null before the first read. */
  continueAt: (ReadingPosition & { surah: Surah }) | null;
  /** Counts below are COUNT() over stored rows, never invented numbers. */
  hifzActive: number;
  hifzDueToday: number;
  hifzWeak: number;
  confusionGroups: number;
  recallAttempts: number;
  notes: Note[];
  bookmarks: Bookmark[];
  recentReading: ReadingHistoryEntry[];
  /** False until the core pack is imported — drives the onboarding state. */
  hasContent: boolean;
  /** False until the user has created any rows — drives the empty states. */
  hasUserData: boolean;
}

/** Options for a note create/update. */
export interface NoteInput {
  id?: string;
  verseKey: VerseKey;
  body: string;
}

export interface BookmarkInput {
  verseKey?: VerseKey;
  page?: number;
  label?: string;
}

export interface DataGateway {
  readonly mode: GatewayMode;

  info(): Promise<GatewayInfo>;
  /** Open storage and bring the schema to version `SCHEMA_VERSION`. */
  ready(): Promise<void>;
  close(): Promise<void>;

  /**
   * Verify every pack listed in `content/index.json` and import them in one
   * atomic step. A failed checksum writes nothing.
   */
  importFromContent(): Promise<ImportReport>;
  /** Atomically replace all content tables with a verified plan. */
  applyImport(plan: ContentPlan, report: ImportReport): Promise<void>;
  resetContent(): Promise<void>;
  importReport(): Promise<ImportReport | null>;
  packs(): Promise<PackRow[]>;
  counts(): Promise<ContentCounts>;

  surahs(): Promise<Surah[]>;
  surah(number: number): Promise<Surah | null>;
  ayah(verseKey: VerseKey): Promise<AyahRow | null>;
  /** Full mushaf text — used by the hifz facade to build the engine context. */
  allAyahTexts(): Promise<AyahRow[]>;
  ayahsByChapter(chapter: number): Promise<AyahRow[]>;
  ayahsByPage(page: number): Promise<AyahRow[]>;
  ayahsByJuz(juz: number): Promise<AyahRow[]>;
  juzList(): Promise<JuzSummary[]>;
  words(verseKey: VerseKey): Promise<AyahWordRow[]>;
  /**
   * Word rows for many ayahs at once. The hifz context needs the gloss of every
   * ayah the learner is holding; asking ayah by ayah would be one serialised
   * statement each, and the queue is one connection.
   */
  wordsFor(verseKeys: VerseKey[]): Promise<AyahWordRow[]>;
  translationOptions(): Promise<TranslationOption[]>;
  translations(verseKeys: VerseKey[], packId: string): Promise<Map<VerseKey, string>>;
  tafsirFor(verseKey: VerseKey): Promise<TafsirRow[]>;
  tafsirSources(): Promise<{ packId: string; title: string; licenseName: string; licenseSpdx: string | null; licenseStatus: LicenseStatus; attribution: ContentAttribution; passages: number }[]>;
  similarTo(verseKey: VerseKey, limit?: number): Promise<SimilarAyahPair[]>;
  relationsOf(verseKey: VerseKey, limit?: number): Promise<AyahRelation[]>;
  audioFor(verseKey: VerseKey): Promise<AudioTrackRow[]>;

  settings(): Promise<Record<string, string>>;
  setSetting(key: string, value: string): Promise<void>;

  bookmarks(): Promise<Bookmark[]>;
  addBookmark(input: BookmarkInput): Promise<Bookmark>;
  removeBookmark(id: string): Promise<void>;

  notesFor(verseKey: VerseKey): Promise<Note[]>;
  recentNotes(limit: number): Promise<Note[]>;
  saveNote(input: NoteInput): Promise<Note>;
  deleteNote(id: string): Promise<void>;

  readingPosition(): Promise<(ReadingPosition & { surah: Surah }) | null>;
  setReadingPosition(verseKey: VerseKey, page: number, scrollFraction: number): Promise<void>;
  recordReading(verseKey: VerseKey, durationMs: number | null): Promise<void>;
  recentReading(limit: number): Promise<ReadingHistoryEntry[]>;

  hifzItems(status?: HifzItemStatus): Promise<HifzItem[]>;
  /**
   * Enrol one verse. Idempotent while a live item for the same key exists:
   * adding `112:1` twice returns the row that is already in the plan rather than
   * opening a second memory track the scheduler would double-book. A key whose
   * item was `dropped` starts a fresh track.
   */
  addHifzItem(verseKey: VerseKey, sequence?: VerseKey[]): Promise<HifzItem>;
  removeHifzItem(id: string): Promise<void>;
  setHifzItemStatus(id: string, status: HifzItemStatus): Promise<void>;
  /** Upsert written by the hifz facade after the engine recomputes an item. */
  upsertHifzItem(item: HifzItem): Promise<void>;
  saveRecallAttempt(attempt: RecallAttempt): Promise<void>;
  /**
   * The stored fingerprint of an item, written by the segmentation path when the
   * item is enrolled. Each row names the ayah its position counts from.
   */
  hifzSegments(itemId?: string): Promise<HifzSegment[]>;
  anchorWords(itemId?: string): Promise<AnchorWord[]>;
  hifzTransitions(itemId?: string): Promise<HifzTransition[]>;
  /**
   * Fingerprint state written back after a graded recitation, for the chunks the
   * engine says it covered.
   *
   * Only the stateful columns are touched — the two stability values and the
   * error count. The tiling (`position`, `from_word`, `to_word`, `text`) and the
   * licensed meaning columns are core's derivation from revelation and are never
   * rewritten by an attempt; a row whose id this store does not hold is skipped,
   * not created.
   */
  updateHifzSegments(segments: HifzSegment[]): Promise<void>;
  /** The same for the hinges: the two counters, the stability and the last practice time. */
  updateHifzTransitions(transitions: HifzTransition[]): Promise<void>;
  recallAttempts(itemId?: string, limit?: number): Promise<RecallAttempt[]>;
  confusionGroups(): Promise<ConfusionGroup[]>;
  saveConfusionGroup(group: ConfusionGroup): Promise<void>;
  hifzSessions(limit: number): Promise<HifzSession[]>;
  saveHifzSession(session: HifzSession): Promise<void>;
  dailyPlan(date: string): Promise<{ date: string; payload: string; generatedAt: string } | null>;
  saveDailyPlan(date: string, payload: string): Promise<void>;

  homeStats(now: Date): Promise<HomeStats>;

  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
  searchBackend(): Promise<SearchBackend>;
  /** Why a stronger backend was skipped, when relevant. Shown on Data health. */
  searchBackendNote?(): Promise<SearchNoteId | null>;

  exportBackup(): Promise<BackupEnvelope>;
  importBackup(envelope: BackupEnvelope): Promise<MigrationResult>;

  /**
   * Backup FILES, as opposed to the envelope in memory. Names, never paths:
   * the shipped path hands the name to argument-validated Rust commands that
   * are scoped to the app-data `backups` directory, and the dev shell keeps
   * them in `localStorage` under `quran.backups`. `createdAt` is empty where
   * the native listing cannot report a timestamp (`backup_list` returns only
   * name, size and digest) — read the envelope for its real `createdAt`.
   */
  backupFiles(): Promise<{ name: string; createdAt: string; bytes: number }[]>;
  /** Returns the location the file was written to, for display only. */
  writeBackupFile(name: string, envelope: BackupEnvelope): Promise<string>;
  /** Null when the file holds no parsable JSON — a malformed file is data, not a crash. */
  readBackupFile(name: string): Promise<BackupEnvelope | null>;
}
