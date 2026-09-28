/**
 * Build-time mutashabihat (similar-ayah) pack.
 *
 * WHY THIS FILE EXISTS. `core/src/mutashabihat/` computes similar-ayah pairs
 * and is fully tested, and the desktop import path already serves them
 * (`desktop/src/gateway/tauriGateway.ts` inserts `plan.similar` into
 * `similar_ayah`, `similarTo()` reads it back, `devGateway` mirrors it, and
 * `desktop/src/content/records.ts` maps `linguistic`-kind pack records into
 * `plan.similar`). What was missing was a *pack* carrying those rows, so the
 * mutashabihat screen always met its empty state. This module closes that gap:
 * it runs the engine over the corpus the pipeline itself just built and writes
 * the pairs out as an ordinary checksummed pack.
 *
 * Three rules this module is built around:
 *
 * 1. **Nothing is invented, nothing is forked.** Every number and every Arabic
 *    phrase comes out of `core/src/mutashabihat/index.ts` + 
 *    `core/src/normalize/arabic.ts` — `buildSimilarityIndex`, `findSimilar`,
 *    `buildPair`, `pairTextScore`. The similarity math, the guards and the
 *    thresholds are the engine's own named constants; this file contains no
 *    scoring logic and no tunable numbers of its own. Re-implementing the
 *    matcher here would be exactly the "web may not fork engine logic" defect
 *    AGENTS.md forbids.
 * 2. **Build time only, no network.** The input is `content/quran-core/payload.jsonl`
 *    — the bytes this same run just emitted and validated against `data/raw`.
 *    Nothing is fetched, and the app never computes a pair at runtime.
 * 3. **Computed, not scholarly.** These are candidate text matches over the
 *    Uthmani text. They are not the classical science of mutashābahāt, not
 *    asbab al-nuzul, and not a religious claim; the engine itself may only
 *    emit `textual`/`linguistic`, never `explicit`
 *    (`docs/mutashabihat.md`). The licence follows the source text's, which is
 *    `unresolved`, so this pack claims nothing clearer.
 *
 * Determinism (same input ⇒ same bytes):
 *   • pairs are de-duplicated by their *unordered* key pair and sorted by
 *     ascending `verseKeyA` then ascending `verseKeyB` (numeric chapter:verse);
 *   • `verseKeyA` is always the canonically smaller key, so no run can emit a
 *     mirror image of another run's row;
 *   • scores are rounded with the engine's own presentation rounding
 *     (`toFixed(4)`, as used by `pairToAyahRelation()` and shown verbatim by
 *     `desktop/src/screens/discover/MutashabihatScreen.tsx`) — no new format is
 *     invented, and rounding happens *after* every engine guard has voted, so
 *     it can never change which pairs exist.
 */

import {
  FIND_SIMILAR_DEFAULT_LIMIT,
  GROUP_PHRASE_TOKENS,
  GROUP_MIN_SCORE,
  LENGTH_BAND_ABS,
  LENGTH_BAND_FRACTION,
  MIN_SCORE_DEFAULT,
  MIN_SCORE_SHORT,
  MIN_SHARED_WORDS,
  MUTASHABIHAT_ALGORITHM_ID,
  MUTASHABIHAT_ALGORITHM_VERSION,
  MUTASHABIHAT_PRODUCED_BY,
  RARE_DF_FRACTION,
  RARE_DF_FLOOR,
  RARE_WORDS_PER_AYAH,
  SHARED_RATIO_DEFAULT,
  SHORT_AYAH_MAX_WORDS,
  SHORT_AYAH_RESULT_CAP,
  SHORT_AYAH_SHARED_RATIO,
  TEXTUAL_SCORE_FLOOR,
  buildSimilarityIndex,
  buildPair,
  findSimilar,
  pairTextScore,
} from '../../../core/src/mutashabihat/index.ts';
import type { SimilarityIndexStats } from '../../../core/src/mutashabihat/index.ts';
import type { Ayah, SimilarAyahPair, VerseKey } from '../../../core/src/contracts/quran.ts';
import { normalizedFingerprint, wordCount } from '../../../core/src/normalize/arabic.ts';
import type {
  ContentAttribution,
  ContentLicense,
  ContentPackManifest,
} from '../../../core/src/contracts/content-pack.ts';

/** Pack id — also its directory name under `content/` (see `payloadPathOf`). */
export const MUTASHABIHAT_PACK_ID = 'mutashabihat-ar';

/** Record discriminator inside the payload, matching quran-core's `_t` style. */
export const MUTASHABIHAT_RECORD_TYPE = 'similar-ayah';

/* ------------------------------------------------------------------ */
/* Pair-record shape (what `records.ts` reads for kind `linguistic`)    */
/* ------------------------------------------------------------------ */

/**
 * One payload line. camelCase contract spelling, like every other pack the
 * build emits; `desktop/src/content/records.ts` also accepts the snake_case
 * forms, but the shipped bytes use one style only.
 */
export interface SimilarAyahRecord {
  _t: typeof MUTASHABIHAT_RECORD_TYPE;
  verseKeyA: VerseKey;
  verseKeyB: VerseKey;
  textScore: number;
  sharedPhrase: string | null;
  differingWords: string[];
  producedBy: string;
}

/* ------------------------------------------------------------------ */
/* License / attribution                                               */
/* ------------------------------------------------------------------ */

export interface PackLicenseSpec {
  license: ContentLicense;
  attribution: Omit<ContentAttribution, 'retrievedAt'>;
}

/**
 * The derived pack inherits its source's licence and says so. The Uthmani text
 * pack it is computed from ships `license.status: 'unresolved'`, so a work made
 * out of those bytes cannot be clearer than that — claiming `clear` here would
 * be a fabricated permission.
 */
export function mutashabihatLicenseSpec(coreChecksum: string): PackLicenseSpec {
  return {
    license: {
      spdx: null,
      name: 'Derived work over the bundled Uthmani Qur’an text (no independent licence claim)',
      url: 'https://quran.com',
      status: 'unresolved',
      notes:
        'Machine-derived data, not a new edition of any text: each row records two existing ' +
        'verse keys plus a score and the shared/differing words quoted out of the Madani Mushaf ' +
        'text itself. It therefore inherits the licence of its input, `quran-core`, whose own ' +
        'status is unresolved (the Quran.com v4 /resources endpoints expose no license field and ' +
        'Quran Foundation developer terms state QF content is not redistributed) — this pack ' +
        'claims nothing clearer than that, and the same written permission has to cover both. ' +
        'The pairs themselves are computed text similarity, not scholarly commentary, so no ' +
        'third-party text is reproduced here beyond the Qur’an wording already in `quran-core`. ' +
        `Input payload sha256 ${coreChecksum}.`,
    },
    attribution: {
      publisher:
        'Computed by @quran/core (core/src/mutashabihat) over the bundled Uthmani text pack; ' +
        'no human editor and no model was involved',
      work: 'Mutashabihat — computed similar-ayah candidate pairs',
      edition: `algorithm:${MUTASHABIHAT_ALGORITHM_ID}@v${MUTASHABIHAT_ALGORITHM_VERSION}`,
      sourceUrl: 'https://quran.com',
      creditLine:
        'Derived from the Qur’an text pack (King Fahd Complex for the Printing of the Holy ' +
        'Qur’an, Madinah al-Munawwarah; served via Quran.com). Pairs are machine-computed ' +
        'textual similarity — candidate study material, not a scholarly mutashābahāt analysis ' +
        'and not a religious claim.',
    },
  };
}

/* ------------------------------------------------------------------ */
/* Derivation metadata (written into the pack manifest)                */
/* ------------------------------------------------------------------ */

/** The manifest fields the contract allows, plus this pack's provenance block. */
export type DerivedContentPackManifest = ContentPackManifest & {
  /** Declared here rather than in `core/src/contracts` on purpose: only packs
   * computed by this repository carry it, and the importer ignores manifest
   * keys it does not know. */
  derived: MutashabihatDerivation;
};

export interface MutashabihatDerivation {
  /** Hard honesty flag: consumers may render this as "computed", never as a source. */
  computed: true;
  presentedAs: 'computed textual similarity — candidate only';
  not: [
    'scholarly mutashābahāt analysis',
    'asbab al-nuzul',
    'a religious or legal claim',
    'model or human output',
  ];
  producedBy: string;
  algorithm: {
    id: typeof MUTASHABIHAT_ALGORITHM_ID;
    version: number;
    module: 'core/src/mutashabihat/index.ts';
    tokenisation: 'core/src/normalize/arabic.ts — tokenizeWords() then normalizeWord()';
  };
  scoreDefinition: string;
  rounding: string;
  params: Record<string, number>;
  inclusionRule: string;
  determinism: Record<string, string>;
  input: {
    packId: 'quran-core';
    payloadFile: 'content/quran-core/payload.jsonl';
    payloadSha256: string;
    ayahCount: number;
  };
  indexStats: SimilarityIndexStats;
  result: {
    pairs: number;
    ayahsWithAtLeastOnePair: number;
    corpusAyahs: number;
    /** ayahs with ≥1 pair / corpus size, 1 decimal, percent. */
    coveragePercent: number;
    pairsAtScoreOne: number;
    pairsWithSharedPhrase: number;
  };
}

/* ------------------------------------------------------------------ */
/* Helpers that are storage concerns, not similarity math               */
/* ------------------------------------------------------------------ */

/**
 * Numeric `chapter:verse` ordering. Mirrors the engine's private
 * `verseKeyOrder`; used only to sort rows and pick the canonical direction for
 * storage — it never decides whether two ayahs are similar.
 */
export function compareVerseKeys(a: VerseKey, b: VerseKey): number {
  const [ca, va] = a.split(':');
  const [cb, vb] = b.split(':');
  const cn = Number(ca) - Number(cb);
  return cn !== 0 ? cn : Number(va) - Number(vb);
}

/** The engine's own presentation rounding, applied once, at build time. */
function roundScore(score: number): number {
  return Number(score.toFixed(4));
}

/** `verseKeyA|verseKeyB` with the canonically smaller key first. */
function canonicalPairKey(a: VerseKey, b: VerseKey): { key: string; a: VerseKey; b: VerseKey } {
  const first = compareVerseKeys(a, b) <= 0 ? { a, b } : { a: b, b: a };
  return { key: `${first.a}|${first.b}`, a: first.a, b: first.b };
}

/* ------------------------------------------------------------------ */
/* Computation                                                         */
/* ------------------------------------------------------------------ */

export interface MutashabihatAyahRow {
  /** Parsed `ayah` rows of the quran-core payload — full contract `Ayah`s. */
  ayahs: Ayah[];
  /** sha256 of the payload those rows came from, for provenance. */
  corePayloadSha256: string;
}

export interface MutashabihatPackResult {
  payload: string;
  records: SimilarAyahRecord[];
  derivation: MutashabihatDerivation;
  licenseSpec: PackLicenseSpec;
}

/**
 * Run the engine over the whole corpus and return every pair it stands behind.
 *
 * Inclusion rule: a pair ships when `findSimilar()` reported it for **at least
 * one** of its two ayahs as the anchor, using the engine's defaults — no
 * `minScore` or `limit` override and no tuning. That keeps every documented
 * guard in play exactly as the unit tests assert it: `MIN_SCORE_DEFAULT` 0.5,
 * `MIN_SHARED_WORDS`, the shared-word ratios, and the short-ayah package
 * (`MIN_SCORE_SHORT` 0.85, `SHORT_AYAH_SHARED_RATIO`, `SHORT_AYAH_RESULT_CAP`)
 * that stops a two-word ayah from matching dozens of verses.
 *
 * Presentation fields are then materialised once per pair in canonical
 * direction with `buildPair()`, so a row is never half-taken-from-one-anchor and
 * half-from-another, and so `verseKeyA < verseKeyB` holds for every line.
 */
export function computeSimilarPairs({ ayahs, corePayloadSha256 }: MutashabihatAyahRow): {
  records: SimilarAyahRecord[];
  indexStats: SimilarityIndexStats;
} {
  const index = buildSimilarityIndex(ayahs);
  const docs = index.byVerseKey;

  // Pass 1 — ask the engine, one anchor at a time, with its own defaults.
  const included = new Set<string>();
  for (const doc of index.docs) {
    for (const pair of findSimilar(doc.verseKey, { index })) {
      included.add(canonicalPairKey(pair.verseKeyA, pair.verseKeyB).key);
    }
  }

  // Pass 2 — materialise each accepted pair once, in canonical direction,
  // through the engine's own `buildPair`.
  const ordered = [...included]
    .map((key) => {
      const [a, b] = key.split('|') as [VerseKey, VerseKey];
      return { a, b };
    })
    .sort((x, y) => compareVerseKeys(x.a, y.a) || compareVerseKeys(x.b, y.b));

  const records: SimilarAyahRecord[] = [];
  for (const { a, b } of ordered) {
    const docA = docs.get(a);
    const docB = docs.get(b);
    // Both sides came out of the same index, so a miss is a bug, not data.
    if (!docA || !docB) {
      throw new Error(`mutashabihat: pair ${a}|${b} is not backed by the index — refusing to emit`);
    }
    const pair: SimilarAyahPair = buildPair(docA, docB, MUTASHABIHAT_PRODUCED_BY);
    const score = roundScore(pair.textScore);
    if (score < MIN_SCORE_DEFAULT) {
      throw new Error(`mutashabihat: pair ${a}|${b} scored ${score} below the engine floor — refusing to emit`);
    }
    records.push({
      _t: MUTASHABIHAT_RECORD_TYPE,
      verseKeyA: pair.verseKeyA,
      verseKeyB: pair.verseKeyB,
      textScore: score,
      sharedPhrase: pair.sharedPhrase,
      differingWords: pair.differingWords,
      producedBy: pair.producedBy,
    });
  }

  // Nothing above may silently widen what `produced_by` means: every row must
  // carry the engine's own constant, or the pack is not the engine's output.
  for (const rec of records) {
    if (rec.producedBy !== MUTASHABIHAT_PRODUCED_BY) {
      throw new Error(`mutashabihat: ${rec.verseKeyA}|${rec.verseKeyB} carries foreign producedBy ${rec.producedBy}`);
    }
    // A stored score must still be what `pairTextScore` says, after the one
    // rounding step above; recomputing catches a stale or hand-edited row.
    const expected = roundScore(pairTextScore(docs.get(rec.verseKeyA)!, docs.get(rec.verseKeyB)!));
    if (rec.textScore !== expected) {
      throw new Error(`mutashabihat: ${rec.verseKeyA}|${rec.verseKeyB} stores ${rec.textScore} but pairTextScore gives ${expected}`);
    }
  }

  return { records, indexStats: index.stats };
}

/** Build the pack payload + provenance from the already-shipped core rows. */
export function buildMutashabihatPack(input: MutashabihatAyahRow): MutashabihatPackResult {
  const { records, indexStats } = computeSimilarPairs(input);

  const covered = new Set<VerseKey>();
  let atOne = 0;
  let withPhrase = 0;
  for (const r of records) {
    covered.add(r.verseKeyA);
    covered.add(r.verseKeyB);
    if (r.textScore === 1) atOne += 1;
    if (r.sharedPhrase !== null) withPhrase += 1;
  }

  const payload = records.map((r) => JSON.stringify(r)).join('\n') + '\n';

  const derivation: MutashabihatDerivation = {
    computed: true,
    presentedAs: 'computed textual similarity — candidate only',
    not: [
      'scholarly mutashābahāt analysis',
      'asbab al-nuzul',
      'a religious or legal claim',
      'model or human output',
    ],
    producedBy: MUTASHABIHAT_PRODUCED_BY,
    algorithm: {
      id: MUTASHABIHAT_ALGORITHM_ID,
      version: MUTASHABIHAT_ALGORITHM_VERSION,
      module: 'core/src/mutashabihat/index.ts',
      tokenisation: 'core/src/normalize/arabic.ts — tokenizeWords() then normalizeWord()',
    },
    scoreDefinition:
      'textScore = max(setSimilarity(a, b), tokenSimilarity(a, b)) over the canonical tokens ' +
      '(normalizeWord(tokenizeWords(textUthmani))) — both functions from core/src/normalize/arabic. ' +
      'setSimilarity is Jaccard over the normalised word sets, tokenSimilarity is 1 − word-level ' +
      'Levenshtein / longer length. 1 means the two ayat share the same normalised vocabulary; 0 ' +
      'means nothing in common. max(), not mean(): for a memoriser a re-ordered identical ' +
      'vocabulary is as confusing as an identical set.',
    rounding: `scores stored with the engine’s own presentation rounding, toFixed(4), applied after every guard has voted`,
    params: {
      MIN_SCORE_DEFAULT,
      MIN_SCORE_SHORT,
      SHORT_AYAH_MAX_WORDS,
      SHORT_AYAH_SHARED_RATIO,
      SHORT_AYAH_RESULT_CAP,
      SHARED_RATIO_DEFAULT,
      MIN_SHARED_WORDS,
      FIND_SIMILAR_DEFAULT_LIMIT,
      RARE_DF_FRACTION,
      RARE_DF_FLOOR,
      RARE_WORDS_PER_AYAH,
      LENGTH_BAND_ABS,
      LENGTH_BAND_FRACTION,
      TEXTUAL_SCORE_FLOOR,
      GROUP_MIN_SCORE,
      GROUP_PHRASE_TOKENS,
    },
    inclusionRule:
      'a pair is emitted when findSimilar() reported it for at least one of its two ayat as the ' +
      'anchor, with the engine’s default minScore and limit and all of its guards (score floor, ' +
      'MIN_SHARED_WORDS, shared-word ratio, short-ayah bar/cap) applied by the engine itself. ' +
      'No threshold was tuned for this pack; the constants above are imported from core.',
    determinism: {
      pairOrder: 'ascending verseKeyA, then ascending verseKeyB (numeric chapter:verse)',
      direction: 'verseKeyA is always the canonically smaller key of the pair',
      deduplication: 'the unordered pair is the identity; the reverse row is never emitted',
      scoreRounding: 'toFixed(4), applied after filtering',
      input: 'the quran-core payload written by this same build run, byte-verified against data/raw',
    },
    input: {
      packId: 'quran-core',
      payloadFile: 'content/quran-core/payload.jsonl',
      payloadSha256: input.corePayloadSha256,
      ayahCount: input.ayahs.length,
    },
    indexStats,
    result: {
      pairs: records.length,
      ayahsWithAtLeastOnePair: covered.size,
      corpusAyahs: input.ayahs.length,
      coveragePercent: Number(((covered.size / input.ayahs.length) * 100).toFixed(1)),
      pairsAtScoreOne: atOne,
      pairsWithSharedPhrase: withPhrase,
    },
  };

  return {
    payload,
    records,
    derivation,
    licenseSpec: mutashabihatLicenseSpec(input.corePayloadSha256),
  };
}

/* ------------------------------------------------------------------ */
/* Reading the core pack back                                          */
/* ------------------------------------------------------------------ */

/**
 * Parse the quran-core payload text into the `Ayah` rows the engine consumes.
 * These are the records this build just wrote and `validatePacks()` just proved
 * byte-identical to `data/raw`, so the pair set describes the mushaf the app
 * actually ships. A row that is not a usable ayah stops the build — a silent
 * skip would quietly shrink the corpus the pairs were computed over.
 *
 * The two fields the pack deliberately defers to the importer (`wordCount`,
 * `normalizedHash`, filled by `desktop/src/content/records.ts` `mapAyah`) are
 * completed here with the *same* core functions, because the engine's `Ayah`
 * argument is a full contract row. Nothing is invented: both are pure
 * functions of the stored Uthmani text, and only `verseKey` + `textUthmani`
 * actually feed the similarity math.
 */
export function coreAyahsFromPayload(text: string): Ayah[] {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const ayahs: Ayah[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const rec = JSON.parse(lines[i]!) as Record<string, unknown>;
    if (rec['_t'] !== 'ayah') continue;
    const verseKey = rec['verseKey'];
    const uthmani = rec['textUthmani'];
    if (
      typeof verseKey !== 'string' ||
      !/^\d{1,3}:\d{1,3}$/.test(verseKey) ||
      typeof uthmani !== 'string' ||
      uthmani.trim() === ''
    ) {
      throw new Error(`mutashabihat: quran-core line ${i + 1} is not a usable ayah row`);
    }
    for (const field of ['chapter', 'verse', 'juz', 'hizb', 'rubElHizb', 'page'] as const) {
      if (typeof rec[field] !== 'number' || !Number.isInteger(rec[field])) {
        throw new Error(`mutashabihat: quran-core line ${i + 1} has no integer ${field}`);
      }
    }
    const [chapter, verse] = verseKey.split(':').map(Number) as [number, number];
    if (rec['chapter'] !== chapter || rec['verse'] !== verse) {
      throw new Error(`mutashabihat: quran-core line ${i + 1} disagrees with its own verse_key`);
    }
    ayahs.push({ ...(rec as unknown as Ayah), textUthmani: uthmani, wordCount: wordCount(uthmani), normalizedHash: normalizedFingerprint(uthmani) });
  }
  if (ayahs.length === 0) throw new Error('mutashabihat: the core payload carries no ayah rows');
  return ayahs;
}
