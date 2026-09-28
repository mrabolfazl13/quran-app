/**
 * DevGateway — browser-only data path for `vite dev`.
 *
 * It is NOT a mockup: it loads the same `content/index.json` and the same pack
 * payloads the Tauri app loads (through the Vite dev server), runs the same
 * verification and record-mapping code in `src/content`, and stores the result
 * in memory. Only the query layer differs — arrays and filters instead of SQL —
 * and user rows are persisted to IndexedDB so a reload keeps your notes.
 *
 * Its whole reason to exist is UI iteration without a native build, so the shell
 * always shows the "dev shell" badge and `info().isShippedPath` is false.
 */
import type {
  AnchorWord,
  AyahRelation,
  BackupEnvelope,
  Bookmark,
  ConfusionGroup,
  HifzItem,
  HifzItemStatus,
  HifzSegment,
  HifzSession,
  HifzTransition,
  MigrationResult,
  Note,
  ReadingHistoryEntry,
  ReadingPosition,
  RecallAttempt,
  SimilarAyahPair,
  Surah,
  VerseKey,
} from '@quran/core';
import { BACKUP_SCHEMA_VERSION } from '@quran/core';
import { buildImportPlan } from '../content/importer';
import { createFetchPackSource, type PackSource } from '../content/packSource';
import { sha256Text } from '../content/hash';
import { MemorySearchService } from './search';
import { countShape } from './tauriGateway';
import { SCHEMA_VERSION } from '../db/schema';
import type {
  AudioTrackRow,
  AyahRow,
  AyahWordRow,
  BookmarkInput,
  ContentCounts,
  ContentPlan,
  DataGateway,
  GatewayInfo,
  HomeStats,
  ImportReport,
  JuzSummary,
  NoteInput,
  PackRow,
  SearchHit,
  SearchOptions,
  TafsirRow,
  TranslationOption,
} from './types';
import { emptyPlan } from './types';

const IDB_NAME = 'quran-dev-shell';
const IDB_STORE = 'userdata';
/** Dev-shell backup files: one localStorage key holding name -> stored envelope. */
const BACKUP_INDEX = 'quran.backups';

interface DevBackupEntry {
  createdAt: string;
  bytes: number;
  json: string;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function readBackupIndex(): Record<string, DevBackupEntry> {
  try {
    const raw = window.localStorage.getItem(BACKUP_INDEX);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, DevBackupEntry> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === 'object' && value !== null) {
        const v = value as Partial<DevBackupEntry>;
        if (typeof v.json === 'string') {
          out[name] = { createdAt: v.createdAt ?? '', bytes: v.bytes ?? byteLength(v.json), json: v.json };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeBackupIndex(index: Record<string, DevBackupEntry>): void {
  try {
    window.localStorage.setItem(BACKUP_INDEX, JSON.stringify(index));
  } catch {
    throw new Error('dev backup storage is full or blocked (private mode?) — nothing was written');
  }
}

interface UserData {
  settings: Record<string, string>;
  bookmarks: Bookmark[];
  notes: Note[];
  position: ReadingPosition | null;
  history: ReadingHistoryEntry[];
  hifzItems: HifzItem[];
  segments: HifzSegment[];
  anchors: AnchorWord[];
  transitions: HifzTransition[];
  attempts: RecallAttempt[];
  groups: ConfusionGroup[];
  sessions: HifzSession[];
  plans: { date: string; payload: string; generatedAt: string }[];
  importReport: ImportReport | null;
}

function emptyUserData(): UserData {
  return {
    settings: {},
    bookmarks: [],
    notes: [],
    position: null,
    history: [],
    hifzItems: [],
    segments: [],
    anchors: [],
    transitions: [],
    attempts: [],
    groups: [],
    sessions: [],
    plans: [],
    importReport: null,
  };
}

async function idbLoad<T>(key: string): Promise<T | null> {
  if (typeof indexedDB === 'undefined') return null;
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(IDB_NAME, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      open.onsuccess = () => {
        const db = open.result;
        try {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).get(key);
          req.onsuccess = () => resolve((req.result as T) ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
      open.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbSave(key: string, value: unknown): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    try {
      const open = indexedDB.open(IDB_NAME, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      open.onsuccess = () => {
        const db = open.result;
        try {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      };
      open.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export class DevGateway implements DataGateway {
  readonly mode = 'dev' as const;

  private content: ContentPlan = emptyPlan();
  private user: UserData = emptyUserData();
  private searchService: MemorySearchService;
  private source: PackSource = createFetchPackSource('/content');
  private saveTimer: number | null = null;
  private ready_ = false;

  constructor() {
    this.searchService = new MemorySearchService(
      () => this.content.searchDocs,
      () => this.content.ayahs,
    );
  }

  async info(): Promise<GatewayInfo> {
    return {
      mode: 'dev',
      label: 'Browser dev shell — not the packaged app',
      database: 'IndexedDB (user rows) + in-memory content',
      contentRoot: this.source.location,
      schemaVersion: SCHEMA_VERSION,
      searchBackend: 'dev-index',
      isShippedPath: false,
    };
  }

  async ready(): Promise<void> {
    if (this.ready_) return;
    const stored = await idbLoad<UserData>('v1');
    if (stored) this.user = { ...emptyUserData(), ...stored };
    this.ready_ = true;
  }

  async close(): Promise<void> {
    this.ready_ = false;
  }

  private touch(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      void idbSave('v1', this.user);
    }, 350);
  }

  // --------------------------------------------------------------- import

  async importFromContent(): Promise<ImportReport> {
    const { report, plan } = await buildImportPlan(this.source);
    if (plan && report.status === 'success') await this.applyImport(plan, report);
    this.user.importReport = report;
    this.touch();
    return report;
  }

  async applyImport(plan: ContentPlan, report: ImportReport): Promise<void> {
    // Build the whole next state first, then assign: an exception inside the
    // mapping can never leave the store half-written.
    const next: ContentPlan = {
      ...plan,
      words: plan.words.map((w, i) => ({ ...w, id: i + 1 })),
    };
    next.words.sort((a, b) => (a.verseKey === b.verseKey ? a.position - b.position : a.verseKey.localeCompare(b.verseKey)));
    this.content = next;
    this.user.importReport = report;
    this.touch();
  }

  async resetContent(): Promise<void> {
    this.content = emptyPlan();
    this.user.importReport = null;
    this.touch();
  }

  async importReport(): Promise<ImportReport | null> {
    return this.user.importReport;
  }

  async packs(): Promise<PackRow[]> {
    return [...this.content.packs].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  }

  async counts(): Promise<ContentCounts> {
    return {
      surahs: this.content.surahs.length,
      ayahs: this.content.ayahs.length,
      words: this.content.words.length,
      translations: this.content.translations.length,
      tafsirs: this.content.tafsirs.length,
      similar: this.content.similar.length,
      relations: this.content.relations.length,
      concepts: this.content.concepts.length,
      audio: this.content.audio.length,
      packs: this.content.packs.length,
      bookmarks: this.user.bookmarks.length,
      notes: this.user.notes.length,
      hifzItems: this.user.hifzItems.length,
      recallAttempts: this.user.attempts.length,
      confusionGroups: this.user.groups.length,
    };
  }

  // ------------------------------------------------------------ quran read

  async surahs(): Promise<Surah[]> {
    return [...this.content.surahs].sort((a, b) => a.number - b.number);
  }

  async surah(number: number): Promise<Surah | null> {
    return this.content.surahs.find((s) => s.number === number) ?? null;
  }

  async ayah(verseKey: VerseKey): Promise<AyahRow | null> {
    return this.content.ayahs.find((a) => a.verseKey === verseKey) ?? null;
  }

  async allAyahTexts(): Promise<AyahRow[]> {
    return this.content.ayahs;
  }

  async ayahsByChapter(chapter: number): Promise<AyahRow[]> {
    return this.content.ayahs.filter((a) => a.chapter === chapter).sort((a, b) => a.verse - b.verse);
  }

  async ayahsByPage(page: number): Promise<AyahRow[]> {
    return this.content.ayahs.filter((a) => a.page === page).sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
  }

  async ayahsByJuz(juz: number): Promise<AyahRow[]> {
    return this.content.ayahs.filter((a) => a.juz === juz).sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
  }

  async juzList(): Promise<JuzSummary[]> {
    const byJuz = new Map<number, AyahRow[]>();
    for (const a of this.content.ayahs) {
      const list = byJuz.get(a.juz) ?? [];
      list.push(a);
      byJuz.set(a.juz, list);
    }
    return [...byJuz.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([juz, list]) => {
        const ordered = [...list].sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
        const first = ordered[0] as AyahRow;
        const last = ordered[ordered.length - 1] as AyahRow;
        return {
          juz,
          firstVerseKey: first.verseKey,
          lastVerseKey: last.verseKey,
          pageFrom: Math.min(...ordered.map((a) => a.page)),
          pageTo: Math.max(...ordered.map((a) => a.page)),
          ayahCount: ordered.length,
        };
      });
  }

  async words(verseKey: VerseKey): Promise<AyahWordRow[]> {
    return this.content.words.filter((w) => w.verseKey === verseKey).sort((a, b) => a.position - b.position);
  }

  async translationOptions(): Promise<TranslationOption[]> {
    const packs = this.content.packs.filter((p) => p.kind === 'translation');
    return packs.map((p) => ({
      packId: p.id,
      title: p.title,
      language: p.language as TranslationOption['language'],
      licenseStatus: p.licenseStatus,
      coverage: this.content.translations.filter((t) => t.packId === p.id).length,
    }));
  }

  async translations(verseKeys: VerseKey[], packId: string): Promise<Map<VerseKey, string>> {
    const wanted = new Set(verseKeys);
    const map = new Map<VerseKey, string>();
    for (const t of this.content.translations) {
      if (t.packId === packId && wanted.has(t.verseKey)) map.set(t.verseKey, t.text);
    }
    return map;
  }

  async tafsirFor(verseKey: VerseKey): Promise<TafsirRow[]> {
    return this.content.tafsirs.filter((t) => t.verseKey === verseKey);
  }

  async tafsirSources(): Promise<
    { packId: string; title: string; licenseName: string; licenseSpdx: string | null; licenseStatus: PackRow['licenseStatus']; attribution: PackRow['attribution']; passages: number }[]
  > {
    return this.content.packs
      .filter((p) => p.kind === 'tafsir')
      .map((p) => ({
        packId: p.id,
        title: p.title,
        licenseName: p.licenseName,
        licenseSpdx: p.licenseSpdx,
        licenseStatus: p.licenseStatus,
        attribution: p.attribution,
        passages: this.content.tafsirs.filter((t) => t.packId === p.id).length,
      }));
  }

  async similarTo(verseKey: VerseKey, limit = 12): Promise<SimilarAyahPair[]> {
    return this.content.similar
      .filter((s) => s.verseKeyA === verseKey || s.verseKeyB === verseKey)
      .sort((a, b) => b.textScore - a.textScore)
      .slice(0, limit);
  }

  async relationsOf(verseKey: VerseKey, limit = 20): Promise<AyahRelation[]> {
    return this.content.relations
      .filter((r) => r.fromVerseKey === verseKey || r.toVerseKey === verseKey)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async audioFor(verseKey: VerseKey): Promise<AudioTrackRow[]> {
    const chapter = Number(verseKey.split(':')[0]);
    return this.content.audio
      .filter((a) => a.verseKey === verseKey || (a.verseKey === null && a.chapter === chapter))
      .slice(0, 4);
  }

  // ----------------------------------------------------------- user data

  async settings(): Promise<Record<string, string>> {
    return { ...this.user.settings };
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.user.settings[key] = value;
    this.touch();
  }

  async bookmarks(): Promise<Bookmark[]> {
    return [...this.user.bookmarks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async addBookmark(input: BookmarkInput): Promise<Bookmark> {
    const bookmark: Bookmark = {
      id: `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      verseKey: input.verseKey ?? null,
      page: input.page ?? null,
      label: input.label ?? null,
      createdAt: new Date().toISOString(),
    };
    this.user.bookmarks = [bookmark, ...this.user.bookmarks];
    this.touch();
    return bookmark;
  }

  async removeBookmark(id: string): Promise<void> {
    this.user.bookmarks = this.user.bookmarks.filter((b) => b.id !== id);
    this.touch();
  }

  async notesFor(verseKey: VerseKey): Promise<Note[]> {
    return this.user.notes.filter((n) => n.verseKey === verseKey).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async recentNotes(limit: number): Promise<Note[]> {
    return [...this.user.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  async saveNote(input: NoteInput): Promise<Note> {
    const now = new Date().toISOString();
    const existing = input.id ? this.user.notes.find((n) => n.id === input.id) : undefined;
    const note: Note = {
      id: existing?.id ?? `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      verseKey: input.verseKey,
      body: input.body,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.user.notes = existing
      ? this.user.notes.map((n) => (n.id === existing.id ? note : n))
      : [note, ...this.user.notes];
    this.touch();
    return note;
  }

  async deleteNote(id: string): Promise<void> {
    this.user.notes = this.user.notes.filter((n) => n.id !== id);
    this.touch();
  }

  async readingPosition(): Promise<(ReadingPosition & { surah: Surah }) | null> {
    const position = this.user.position;
    if (!position) return null;
    const surah = await this.surah(Number(position.verseKey.split(':')[0]));
    if (!surah) return null;
    return { ...position, surah };
  }

  async setReadingPosition(verseKey: VerseKey, page: number, scrollFraction: number): Promise<void> {
    this.user.position = { verseKey, page, scrollFraction, updatedAt: new Date().toISOString() };
    this.touch();
  }

  async recordReading(verseKey: VerseKey, durationMs: number | null): Promise<void> {
    this.user.history = [
      { verseKey, readAt: new Date().toISOString(), durationMs },
      ...this.user.history,
    ].slice(0, 2000);
    this.touch();
  }

  async recentReading(limit: number): Promise<ReadingHistoryEntry[]> {
    return this.user.history.slice(0, limit);
  }

  // ---------------------------------------------------------------- hifz

  async hifzItems(status?: HifzItemStatus): Promise<HifzItem[]> {
    const items = status ? this.user.hifzItems.filter((i) => i.status === status) : this.user.hifzItems;
    return [...items].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }

  async addHifzItem(verseKey: VerseKey, sequence?: VerseKey[]): Promise<HifzItem> {
    const item: HifzItem = {
      id: `hi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      verseKey,
      sequence: sequence?.length ? sequence : [verseKey],
      addedAt: new Date().toISOString(),
      status: 'active',
      band: 'new',
      stability: 0,
      strength: 0,
      lastReviewedAt: null,
      nextReviewAt: null,
      attemptCount: 0,
      errorCount: 0,
    };
    this.user.hifzItems = [item, ...this.user.hifzItems];
    this.touch();
    return item;
  }

  async removeHifzItem(id: string): Promise<void> {
    this.user.hifzItems = this.user.hifzItems.filter((i) => i.id !== id);
    this.user.segments = this.user.segments.filter((s) => s.itemId !== id);
    this.user.anchors = this.user.anchors.filter((a) => a.itemId !== id);
    this.user.transitions = this.user.transitions.filter((t) => t.itemId !== id);
    this.touch();
  }

  async setHifzItemStatus(id: string, status: HifzItem['status']): Promise<void> {
    this.user.hifzItems = this.user.hifzItems.map((i) => (i.id === id ? { ...i, status } : i));
    this.touch();
  }

  async upsertHifzItem(item: HifzItem): Promise<void> {
    const exists = this.user.hifzItems.some((i) => i.id === item.id);
    this.user.hifzItems = exists
      ? this.user.hifzItems.map((i) => (i.id === item.id ? item : i))
      : [item, ...this.user.hifzItems];
    this.touch();
  }

  async saveRecallAttempt(attempt: RecallAttempt): Promise<void> {
    this.user.attempts = [...this.user.attempts, attempt];
    this.touch();
  }

  async hifzSegments(itemId?: string): Promise<HifzSegment[]> {
    return itemId ? this.user.segments.filter((s) => s.itemId === itemId) : this.user.segments;
  }

  async anchorWords(itemId?: string): Promise<AnchorWord[]> {
    return itemId ? this.user.anchors.filter((a) => a.itemId === itemId) : this.user.anchors;
  }

  async hifzTransitions(itemId?: string): Promise<HifzTransition[]> {
    return itemId ? this.user.transitions.filter((t) => t.itemId === itemId) : this.user.transitions;
  }

  async recallAttempts(itemId?: string, limit = 500): Promise<RecallAttempt[]> {
    const items = itemId ? this.user.attempts.filter((a) => a.itemId === itemId) : this.user.attempts;
    return items.slice(-limit);
  }

  async confusionGroups(): Promise<ConfusionGroup[]> {
    return [...this.user.groups].sort((a, b) => b.confusionCount - a.confusionCount);
  }

  async saveConfusionGroup(group: ConfusionGroup): Promise<void> {
    const exists = this.user.groups.some((g) => g.id === group.id);
    this.user.groups = exists
      ? this.user.groups.map((g) => (g.id === group.id ? group : g))
      : [group, ...this.user.groups];
    this.touch();
  }

  async hifzSessions(limit: number): Promise<HifzSession[]> {
    return [...this.user.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  async saveHifzSession(session: HifzSession): Promise<void> {
    const exists = this.user.sessions.some((s) => s.id === session.id);
    this.user.sessions = exists
      ? this.user.sessions.map((s) => (s.id === session.id ? session : s))
      : [session, ...this.user.sessions];
    this.touch();
  }

  async dailyPlan(date: string): Promise<{ date: string; payload: string; generatedAt: string } | null> {
    return this.user.plans.find((p) => p.date === date) ?? null;
  }

  async saveDailyPlan(date: string, payload: string): Promise<void> {
    const entry = { date, payload, generatedAt: new Date().toISOString() };
    this.user.plans = [...this.user.plans.filter((p) => p.date !== date), entry];
    this.touch();
  }

  // -------------------------------------------------------------- search

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    return this.searchService.search(query, options);
  }

  async searchBackend(): Promise<'dev-index'> {
    return 'dev-index';
  }

  async searchBackendNote(): Promise<string | null> {
    return this.searchService.note;
  }

  // ------------------------------------------------------------ dashboard

  async homeStats(now: Date): Promise<HomeStats> {
    const iso = now.toISOString();
    const counts = await this.counts();
    return {
      continueAt: await this.readingPosition(),
      hifzActive: counts.hifzItems,
      hifzDueToday: this.user.hifzItems.filter(
        (i) => i.status === 'active' && i.nextReviewAt !== null && i.nextReviewAt <= iso,
      ).length,
      hifzWeak: this.user.hifzItems.filter((i) => i.status === 'active' && (i.band === 'weak' || i.band === 'unstable')).length,
      confusionGroups: this.user.groups.length,
      recallAttempts: this.user.attempts.length,
      notes: await this.recentNotes(5),
      bookmarks: (await this.bookmarks()).slice(0, 6),
      recentReading: await this.recentReading(6),
      hasContent: counts.ayahs > 0,
      hasUserData: counts.hifzItems + counts.notes + counts.bookmarks + counts.recallAttempts > 0,
    };
  }

  // --------------------------------------------------------------- backup

  async exportBackup(): Promise<BackupEnvelope> {
    const data: BackupEnvelope['data'] = {
      settings: this.user.settings,
      bookmarks: this.user.bookmarks,
      notes: this.user.notes,
      readingPositions: this.user.position ? [this.user.position] : [],
      readingHistory: this.user.history,
      hifzItems: this.user.hifzItems,
      hifzSegments: this.user.segments,
      anchorWords: this.user.anchors,
      hifzTransitions: this.user.transitions,
      recallAttempts: this.user.attempts,
      confusionGroups: this.user.groups,
      sessions: this.user.sessions,
      journeys: [],
      reflections: [],
      dailyPlans: this.user.plans,
    };
    const checksum = await sha256Text(JSON.stringify(data));
    return {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      minReaderVersion: 1,
      createdAt: new Date().toISOString(),
      producedBy: { app: 'quran-desktop', version: '0.1.0', platform: 'desktop' },
      checksum,
      counts: countShape(data),
      data,
    };
  }

  async importBackup(envelope: BackupEnvelope): Promise<MigrationResult> {
    if (envelope.schemaVersion > BACKUP_SCHEMA_VERSION) {
      return { ok: false, from: envelope.schemaVersion, error: `backup schema v${envelope.schemaVersion} is newer than v${BACKUP_SCHEMA_VERSION}` };
    }
    if (envelope.schemaVersion < BACKUP_SCHEMA_VERSION) {
      return { ok: false, from: envelope.schemaVersion, error: `backup v${envelope.schemaVersion} needs a migration; only v${BACKUP_SCHEMA_VERSION} can be read directly` };
    }
    const digest = await sha256Text(JSON.stringify(envelope.data));
    if (digest.toLowerCase() !== envelope.checksum.trim().toLowerCase()) {
      return { ok: false, from: envelope.schemaVersion, error: 'backup checksum does not match its contents — the file is corrupt or edited' };
    }
    this.user = {
      ...emptyUserData(),
      importReport: this.user.importReport,
      settings: { ...(envelope.data.settings as Record<string, string>) },
      bookmarks: (envelope.data.bookmarks as Bookmark[]) ?? [],
      notes: (envelope.data.notes as Note[]) ?? [],
      position: (envelope.data.readingPositions as ReadingPosition[])[0] ?? null,
      history: (envelope.data.readingHistory as ReadingHistoryEntry[]) ?? [],
      hifzItems: (envelope.data.hifzItems as HifzItem[]) ?? [],
      segments: (envelope.data.hifzSegments as HifzSegment[]) ?? [],
      anchors: (envelope.data.anchorWords as AnchorWord[]) ?? [],
      transitions: (envelope.data.hifzTransitions as HifzTransition[]) ?? [],
      attempts: (envelope.data.recallAttempts as RecallAttempt[]) ?? [],
      groups: (envelope.data.confusionGroups as ConfusionGroup[]) ?? [],
      sessions: (envelope.data.sessions as HifzSession[]) ?? [],
      plans: (envelope.data.dailyPlans as { date: string; payload: string; generatedAt: string }[]) ?? [],
    };
    this.touch();
    return { ok: true, from: envelope.schemaVersion, to: BACKUP_SCHEMA_VERSION, warnings: [] };
  }

  // ------------------------------------------------------ backup files
  //
  // There is no filesystem in a browser, so a dev "file" is a localStorage
  // entry under one `quran.backups` index. It is a dev-shell artefact and the
  // UI says so: it must never be mistaken for a portable `.quranbak` file.

  async backupFiles(): Promise<{ name: string; createdAt: string; bytes: number }[]> {
    const index = readBackupIndex();
    return Object.entries(index)
      .map(([name, entry]) => ({ name, createdAt: entry.createdAt, bytes: entry.bytes }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name));
  }

  async writeBackupFile(name: string, envelope: BackupEnvelope): Promise<string> {
    const json = JSON.stringify(envelope);
    const index = readBackupIndex();
    index[name] = { createdAt: envelope.createdAt || new Date().toISOString(), bytes: byteLength(json), json };
    writeBackupIndex(index);
    return `localStorage:${BACKUP_INDEX}/${name}`;
  }

  async readBackupFile(name: string): Promise<BackupEnvelope | null> {
    const entry = readBackupIndex()[name];
    if (!entry) return null;
    try {
      return JSON.parse(entry.json) as BackupEnvelope;
    } catch {
      return null;
    }
  }
}

