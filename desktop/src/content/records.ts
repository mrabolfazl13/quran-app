/**
 * Pack record → row mapping.
 *
 * `tools/content` owns pack generation; this module owns how the desktop reads
 * them. The mapping is deliberately tolerant on *field spelling* (camelCase or
 * the provider's snake_case) and strict on *meaning*: a record that does not
 * satisfy a contract rule is an error, never a coerced guess. The Quran text is
 * copied through byte-for-byte — it is never trimmed, rejoined or re-vocalised.
 */
import {
  AYAH_COUNT,
  JUZ_COUNT,
  MAX_MUSHAF_LINES,
  PAGE_COUNT,
  SURAH_COUNT,
  normalizeWord,
  normalizedFingerprint,
  normalizedText,
  tokenizeWords,
  wordCount,
} from '@quran/core';
import type {
  AyahRelation,
  Concept,
  ConceptAyahLink,
  ConceptRelation,
  ContentPackManifest,
  PackKind,
  RelationType,
  SimilarAyahPair,
  Surah,
  VerseKey,
} from '@quran/core';
import type {
  AyahRow,
  AyahWordRow,
  AudioTrackRow,
  ContentPlan,
  ImportIssue,
  PackRow,
  TafsirRow,
  TranslationRow,
} from '../gateway/types';
import { emptyPlan } from '../gateway/types';

export type RawRecord = Record<string, unknown>;

const VERSE_KEY_RE = /^(\d{1,3}):(\d{1,4})$/;

/** First non-empty string among the candidate keys. */
function str(rec: RawRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function num(rec: RawRecord, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function bool(rec: RawRecord, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'boolean') return v;
    if (v === 1 || v === '1' || v === 'true') return true;
    if (v === 0 || v === '0' || v === 'false') return false;
  }
  return null;
}

function arr(rec: RawRecord, ...keys: string[]): unknown[] | null {
  for (const key of keys) {
    const v = rec[key];
    if (Array.isArray(v)) return v;
  }
  return null;
}

export function parseVerseKey(value: string | null): VerseKey | null {
  if (!value) return null;
  const m = VERSE_KEY_RE.exec(value.trim());
  if (!m) return null;
  const chapter = Number(m[1]);
  const verse = Number(m[2]);
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > SURAH_COUNT) return null;
  if (!Number.isInteger(verse) || verse < 1) return null;
  return `${chapter}:${verse}` as VerseKey;
}

export interface MapResult {
  plan: ContentPlan;
  issues: ImportIssue[];
  warnings: ImportIssue[];
  recordsApplied: number;
}

/** Directory layout of a pack inside the content bundle. */
export function payloadPathOf(manifest: ContentPackManifest): string {
  const withPath = manifest as ContentPackManifest & { payloadPath?: string };
  return withPath.payloadPath ?? `${manifest.id}/payload.jsonl`;
}

export function manifestPathOf(manifest: ContentPackManifest): string {
  const withPath = manifest as ContentPackManifest & { manifestPath?: string };
  return withPath.manifestPath ?? `${manifest.id}/pack.json`;
}

/** Pack manifest → the `content_pack` row the UI shows everywhere. */
export function packRowOf(manifest: ContentPackManifest, importedAt: string): PackRow {
  return {
    id: manifest.id,
    kind: manifest.kind,
    version: manifest.version,
    schemaVersion: manifest.schemaVersion,
    language: manifest.language,
    title: manifest.title,
    source: manifest.source,
    licenseName: manifest.license.name,
    licenseSpdx: manifest.license.spdx,
    licenseStatus: manifest.license.status,
    licenseNotes: manifest.license.notes,
    attribution: manifest.attribution,
    checksum: manifest.checksum,
    payloadBytes: manifest.payloadBytes,
    recordCount: manifest.recordCount,
    importedAt,
  };
}

function revelationPlace(value: string | null): 'makkah' | 'madinah' | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.startsWith('makk') || v === 'meccan') return 'makkah';
  if (v.startsWith('madin') || v === 'medinan') return 'madinah';
  return null;
}

function relationType(value: string | null, fallback: RelationType): RelationType {
  const allowed: RelationType[] = [
    'explicit',
    'textual',
    'linguistic',
    'thematic',
    'educational',
    'editorial',
  ];
  const v = (value ?? fallback) as RelationType;
  return allowed.includes(v) ? v : fallback;
}

/**
 * Map one verified payload's records into the plan.
 * Unknown pack kinds are kept as installed packs (so attribution still shows)
 * but contribute no rows, and are reported as warnings rather than silently
 * dropped.
 */
export function mapRecords(manifest: ContentPackManifest, records: RawRecord[]): MapResult {
  const plan = emptyPlan();
  const issues: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const fail = (stage: ImportIssue['stage'], message: string, index: number): void => {
    issues.push({
      stage,
      packId: manifest.id,
      message,
      detail: `record #${index + 1} of ${manifest.id}`,
    });
  };

  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i] as RawRecord;
    const discriminator = str(rec, 'type', 'recordType', 'kind');

    switch (manifest.kind) {
      case 'quran-core': {
        // A core pack carries surah metadata, ayah text and optionally words.
        if (str(rec, 'name_arabic', 'nameArabic') !== null && num(rec, 'number') !== null) {
          const surah = mapSurah(rec);
          if (!surah) fail('record-shape', 'surah record is missing or out of range', i);
          else plan.surahs.push(surah);
          break;
        }
        if (str(rec, 'text_uthmani', 'textUthmani', 'text') !== null) {
          const ayah = mapAyah(rec);
          if (!ayah) fail('record-shape', 'ayah record has no usable verse_key or empty text', i);
          else if (ayah.textUthmani.trim().length === 0) {
            fail('integrity', 'ayah text is empty after normalisation', i);
          } else {
            plan.ayahs.push(ayah);
          }
          break;
        }
        if (num(rec, 'position') !== null && str(rec, 'text_uthmani', 'textUthmani') !== null) {
          const word = mapWord(rec, str(rec, 'verse_key', 'verseKey'));
          if (!word) fail('record-shape', 'word record is malformed', i);
          else plan.words.push(word);
          break;
        }
        // Anything else (juz/hizb tables, bismillah rows) is informational.
        warnings.push({
          stage: 'record-shape',
          packId: manifest.id,
          message: `unmapped record shape in ${manifest.id} (#${i + 1}); kept, not imported`,
        });
        break;
      }

      case 'word-data': {
        const word = mapWord(rec, str(rec, 'verse_key', 'verseKey'));
        if (!word) fail('record-shape', 'word record is malformed', i);
        else plan.words.push(word);
        break;
      }

      case 'translation': {
        const verseKey = parseVerseKey(str(rec, 'verse_key', 'verseKey'));
        const text = str(rec, 'text', 'translation', 'textTranslation');
        if (!verseKey || !text) {
          fail('record-shape', 'translation record needs verse_key and text', i);
          break;
        }
        const row: TranslationRow = {
          verseKey,
          packId: str(rec, 'pack_id', 'packId') ?? manifest.id,
          text,
        };
        plan.translations.push(row);
        break;
      }

      case 'tafsir': {
        const verseKey = parseVerseKey(str(rec, 'verse_key', 'verseKey'));
        const text = str(rec, 'text', 'tafsir', 'body');
        if (!verseKey || !text) {
          fail('record-shape', 'tafsir record needs verse_key and text', i);
          break;
        }
        const covers = (arr(rec, 'covers_verse_keys', 'coversVerseKeys') ?? [])
          .map((v) => parseVerseKey(String(v)))
          .filter((v): v is VerseKey => v !== null);
        const row: TafsirRow = {
          verseKey,
          packId: str(rec, 'pack_id', 'packId') ?? manifest.id,
          text,
          coversVerseKeys: covers.length > 0 ? covers : [verseKey],
        };
        plan.tafsirs.push(row);
        break;
      }

      case 'audio': {
        const verseKey = parseVerseKey(str(rec, 'verse_key', 'verseKey'));
        const filePath = str(rec, 'file_path', 'filePath', 'url');
        if (!filePath) {
          fail('record-shape', 'audio record has no file path', i);
          break;
        }
        plan.audio.push({
          id: str(rec, 'id') ?? `${manifest.id}:${verseKey ?? str(rec, 'chapter') ?? 's'}`,
          verseKey,
          chapter: num(rec, 'chapter', 'surah'),
          reciter: str(rec, 'reciter', 'reciterName') ?? manifest.attribution.publisher,
          filePath,
          durationMs: num(rec, 'duration_ms', 'durationMs'),
          licenseStatus: manifest.license.status,
        } satisfies AudioTrackRow);
        break;
      }

      case 'concepts': {
        if (discriminator === 'concept_ayah' || str(rec, 'concept_id', 'conceptId') !== null) {
          const conceptId = str(rec, 'concept_id', 'conceptId');
          const verseKey = parseVerseKey(str(rec, 'verse_key', 'verseKey'));
          if (!conceptId || !verseKey) {
            fail('record-shape', 'concept link needs conceptId and verse_key', i);
            break;
          }
          const link: ConceptAyahLink = {
            conceptId,
            verseKey,
            type: relationType(str(rec, 'type'), 'editorial'),
            reason: str(rec, 'reason') ?? '',
          };
          if (link.reason === '') fail('integrity', 'concept link has no stated reason', i);
          plan.conceptAyah.push(link);
        } else if (discriminator === 'concept_relation' || str(rec, 'from_concept_id', 'fromConceptId') !== null) {
          const from = str(rec, 'from_concept_id', 'fromConceptId');
          const to = str(rec, 'to_concept_id', 'toConceptId');
          const type = str(rec, 'type') as ConceptRelation['type'] | null;
          if (!from || !to || !type) {
            fail('record-shape', 'concept relation needs both endpoints and a type', i);
            break;
          }
          plan.conceptRelations.push({
            fromConceptId: from,
            toConceptId: to,
            type,
            note: str(rec, 'note') ?? '',
          });
        } else {
          const id = str(rec, 'id');
          if (!id) {
            fail('record-shape', 'concept record has no id', i);
            break;
          }
          plan.concepts.push({
            id,
            labelArabic: str(rec, 'label_arabic', 'labelArabic') ?? '',
            labelFa: str(rec, 'label_fa', 'labelFa') ?? '',
            labelEn: str(rec, 'label_en', 'labelEn') ?? '',
            descriptionFa: str(rec, 'description_fa', 'descriptionFa') ?? '',
            relationType: relationType(str(rec, 'relation_type', 'relationType'), 'editorial'),
            producedBy: str(rec, 'produced_by', 'producedBy') ?? manifest.id,
          } satisfies Concept);
        }
        break;
      }

      case 'linguistic':
      case 'educational': {
        if (
          str(rec, 'shared_phrase', 'sharedPhrase') !== null ||
          num(rec, 'text_score', 'textScore') !== null
        ) {
          const a = parseVerseKey(str(rec, 'verse_key_a', 'verseKeyA'));
          const b = parseVerseKey(str(rec, 'verse_key_b', 'verseKeyB'));
          const score = num(rec, 'text_score', 'textScore');
          if (!a || !b || score === null) {
            fail('record-shape', 'similar-ayah pair needs both keys and text_score', i);
            break;
          }
          plan.similar.push({
            verseKeyA: a,
            verseKeyB: b,
            textScore: score,
            sharedPhrase: str(rec, 'shared_phrase', 'sharedPhrase'),
            differingWords: (arr(rec, 'differing_words', 'differingWords') ?? []).map(String),
            producedBy: str(rec, 'produced_by', 'producedBy') ?? manifest.id,
          } satisfies SimilarAyahPair);
        } else {
          const from = parseVerseKey(str(rec, 'from_verse_key', 'fromVerseKey'));
          const to = parseVerseKey(str(rec, 'to_verse_key', 'toVerseKey'));
          if (!from || !to) {
            fail('record-shape', 'relation needs from/to verse keys', i);
            break;
          }
          const reason = str(rec, 'reason');
          if (!reason) {
            fail('integrity', 'relation without a reason is not allowed', i);
            break;
          }
          plan.relations.push({
            fromVerseKey: from,
            toVerseKey: to,
            type: relationType(str(rec, 'type'), 'thematic'),
            reason,
            score: num(rec, 'score') ?? 0,
            producedBy: str(rec, 'produced_by', 'producedBy') ?? manifest.id,
          } satisfies AyahRelation);
        }
        break;
      }

      default: {
        warnings.push({
          stage: 'record-shape',
          packId: manifest.id,
          message: `no desktop row mapping for pack kind "${manifest.kind}" — attribution is still shown, records are not imported`,
        });
      }
    }
  }

  const recordsApplied =
    plan.surahs.length +
    plan.ayahs.length +
    plan.words.length +
    plan.translations.length +
    plan.tafsirs.length +
    plan.similar.length +
    plan.relations.length +
    plan.concepts.length +
    plan.conceptAyah.length +
    plan.conceptRelations.length +
    plan.audio.length;

  return { plan, issues, warnings, recordsApplied };
}

export function mapSurah(rec: RawRecord): Surah | null {
  const number = num(rec, 'number', 'id', 'surahNumber');
  const nameArabic = str(rec, 'name_arabic', 'nameArabic');
  if (number === null || !Number.isInteger(number) || number < 1 || number > SURAH_COUNT) return null;
  if (!nameArabic) return null;
  const ayahCount = num(rec, 'ayah_count', 'ayahCount', 'numberOfVerses');
  const pagesFrom = num(rec, 'pages_from', 'pagesFrom', 'pageFrom');
  const pagesTo = num(rec, 'pages_to', 'pagesTo', 'pageTo');
  if (ayahCount === null || pagesFrom === null || pagesTo === null) return null;
  const place = revelationPlace(str(rec, 'revelation_place', 'revelationPlace', 'revelationType'));
  // The contract has no "unknown" place, and inventing one would be a claim
  // about revelation history, so an absent value is a shape error instead.
  if (!place) return null;
  const first = parseVerseKey(str(rec, 'first_verse_key', 'firstVerseKey'));
  const last = parseVerseKey(str(rec, 'last_verse_key', 'lastVerseKey'));
  const bismillah = bool(rec, 'bismillah_pre', 'bismillahPre');
  return {
    number,
    nameArabic,
    nameSimple: str(rec, 'name_simple', 'nameSimple') ?? nameArabic,
    nameTransliterated: str(rec, 'name_transliterated', 'nameTransliterated') ?? '',
    translationFa: str(rec, 'translation_fa', 'translationFa'),
    translationEn: str(rec, 'translation_en', 'translationEn'),
    revelationPlace: place,
    revelationOrder: num(rec, 'revelation_order', 'revelationOrder') ?? number,
    ayahCount,
    pagesFrom,
    pagesTo,
    firstVerseKey: first ?? (`${number}:1` as VerseKey),
    lastVerseKey: last ?? (`${number}:${ayahCount}` as VerseKey),
    // Only An-Naml (27) excludes the basmalah from verse 1 in the Mushaf
    // project's convention; when the pack states it, the pack wins.
    bismillahPre: bismillah ?? number !== 27,
  };
}

export function mapAyah(rec: RawRecord): AyahRow | null {
  const verseKey = parseVerseKey(str(rec, 'verse_key', 'verseKey', 'key'));
  const text = str(rec, 'text_uthmani', 'textUthmani', 'text');
  if (!verseKey || !text) return null;
  const [chapterPart, versePart] = verseKey.split(':');
  const chapter = Number(chapterPart);
  const verse = Number(versePart);
  const declaredChapter = num(rec, 'chapter', 'surah_number', 'surahNumber');
  const declaredVerse = num(rec, 'verse', 'verse_number', 'verseNumber');
  if (declaredChapter !== null && declaredChapter !== chapter) return null;
  if (declaredVerse !== null && declaredVerse !== verse) return null;
  const page = num(rec, 'page', 'page_number', 'pageNumber');
  const juz = num(rec, 'juz', 'juz_number', 'juzNumber');
  const hizb = num(rec, 'hizb', 'hizb_number', 'hizbNumber');
  if (page === null || page < 1 || page > PAGE_COUNT) return null;
  if (juz === null || juz < 1 || juz > JUZ_COUNT) return null;
  const simple = str(rec, 'text_uthmani_simple', 'textUthmaniSimple');
  return {
    verseKey,
    chapter,
    verse,
    sourceId: num(rec, 'source_id', 'sourceId'),
    juz,
    hizb: hizb ?? (juz - 1) * 2 + 1,
    rubElHizb: num(rec, 'rub_el_hizb', 'rubElHizb', 'rub_el_hizb_number') ?? ((hizb ?? 1) - 1) * 2 + 1,
    sajda: num(rec, 'sajda', 'sajdah_number', 'sajdahNumber'),
    ruku: num(rec, 'ruku', 'ruku_number', 'rukuNumber'),
    manzil: num(rec, 'manzil', 'manzil_number', 'manzilNumber'),
    page,
    textUthmani: text,
    textUthmaniSimple: simple,
    wordCount: wordCount(text),
    normalizedHash: normalizedFingerprint(text),
  };
}

export function mapWord(rec: RawRecord, verseKeyCandidate: string | null): AyahWordRow | null {
  const verseKey = parseVerseKey(str(rec, 'verse_key', 'verseKey') ?? verseKeyCandidate);
  const text = str(rec, 'text_uthmani', 'textUthmani', 'text');
  const position = num(rec, 'position', 'number', 'wordPosition');
  if (!verseKey || !text || position === null || position < 1) return null;
  // Mushaf grid placement. The reader rebuilds the 604-page grid from these two
  // numbers at runtime, so a word row that does not carry a usable pair is a
  // shape error: defaulting to page 1 would silently fabricate layout.
  const pageNumber = num(rec, 'page_number', 'pageNumber');
  const lineNumber = num(rec, 'line_number', 'lineNumber');
  if (pageNumber === null || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > PAGE_COUNT) return null;
  if (lineNumber === null || !Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > MAX_MUSHAF_LINES) return null;
  const mark = bool(rec, 'is_end_of_ayah_mark', 'isEndOfAyahMark');
  const isMark = mark ?? tokenizeWords(text).length === 0;
  return {
    // `id` is assigned by the importer in write order; provider ids are kept in
    // the contract's `sourceId` spirit and are never used as a foreign key.
    id: position,
    verseKey,
    position,
    pageNumber,
    lineNumber,
    textUthmani: text,
    translationEn: str(rec, 'translation_en', 'translationEn', 'translation'),
    transliteration: str(rec, 'transliteration'),
    root: str(rec, 'root'),
    morphology: str(rec, 'morphology'),
    isEndOfAyahMark: isMark,
    normalized: normalizeWord(text),
  };
}

/**
 * Cross-pack integrity, run before anything is written.
 *
 * These are the rules AGENTS.md cares about: text is immutable, counts must add
 * up, and a full mushaf must be exactly 114 surahs / 6236 ayahs.
 */
export function validatePlan(plan: ContentPlan, manifests: ContentPackManifest[]): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const packIdOfKind = (kind: PackKind): string | undefined =>
    manifests.find((m) => m.kind === kind)?.id;

  // verse keys must be unique and contiguous per chapter
  const seenAyah = new Map<string, number>();
  for (const ayah of plan.ayahs) {
    const key = ayah.verseKey;
    if (seenAyah.has(key)) {
      issues.push({
        stage: 'integrity',
        packId: packIdOfKind('quran-core'),
        message: `duplicate verse_key ${key} in the core pack`,
      });
    }
    seenAyah.set(key, ayah.verse);
  }

  for (const surah of plan.surahs) {
    let count = 0;
    let expected = 1;
    for (const ayah of plan.ayahs) {
      if (ayah.chapter !== surah.number) continue;
      if (ayah.verse !== expected) {
        issues.push({
          stage: 'integrity',
          packId: packIdOfKind('quran-core'),
          message: `surah ${surah.number}: verse keys are not contiguous (expected ${surah.number}:${expected}, found ${ayah.verse})`,
        });
        break;
      }
      count += 1;
      expected += 1;
    }
    if (count > 0 && count !== surah.ayahCount) {
      issues.push({
        stage: 'integrity',
        packId: packIdOfKind('quran-core'),
        message: `surah ${surah.number} declares ${surah.ayahCount} ayahs but the pack carries ${count}`,
      });
    }
  }

  const fullMushaf = plan.surahs.length === SURAH_COUNT;
  if (fullMushaf && plan.ayahs.length !== AYAH_COUNT) {
    issues.push({
      stage: 'integrity',
      packId: packIdOfKind('quran-core'),
      message: `all ${SURAH_COUNT} surahs are present but the ayah count is ${plan.ayahs.length}, expected ${AYAH_COUNT}`,
    });
  }

  const ayahSet = new Set<string>(plan.ayahs.map((a) => a.verseKey));
  const orphan = (label: string, key: string): void => {
    if (!ayahSet.has(key)) {
      issues.push({
        stage: 'integrity',
        message: `${label} references ${key}, which is not in the imported mushaf`,
      });
    }
  };
  if (ayahSet.size > 0) {
    for (const t of plan.translations) orphan('translation', t.verseKey);
    for (const t of plan.tafsirs) orphan('tafsir', t.verseKey);
    for (const t of plan.similar) {
      // `similar_ayah` has no foreign key and no `produced_by` CHECK (see
      // `core/src/contracts/db.sql`), so a pair naming an ayah that is not in
      // the mushaf would be written silently and then surface as a dead row on
      // the mutashabihat screen. Both ends are checked for the same reason the
      // derived pack is built from these ayahs in the first place.
      orphan('similar pair', t.verseKeyA);
      orphan('similar pair', t.verseKeyB);
    }
    for (const w of plan.words) orphan('word', w.verseKey);
    for (const l of plan.conceptAyah) orphan('concept link', l.verseKey);
  }

  return issues;
}

/** Build the search index rows from a plan (Arabic is normalised, never altered in the ayah table). */
export function buildSearchDocs(plan: ContentPlan): void {
  const enByAyah = new Map<string, string>();
  const faByAyah = new Map<string, string>();
  const enPacks = plan.packs.filter((p) => p.language === 'en' && p.kind === 'translation').map((p) => p.id);
  const faPacks = plan.packs.filter((p) => p.language === 'fa' && p.kind === 'translation').map((p) => p.id);

  for (const t of plan.translations) {
    if (enPacks.includes(t.packId)) enByAyah.set(t.verseKey, t.text);
    if (faPacks.includes(t.packId)) faByAyah.set(t.verseKey, t.text);
  }

  plan.searchDocs = plan.ayahs.map((ayah) => ({
    verseKey: ayah.verseKey,
    arabic: normalizedText(ayah.textUthmani),
    translationEn: enByAyah.get(ayah.verseKey) ?? '',
    translationFa: faByAyah.get(ayah.verseKey) ?? '',
  }));
}
