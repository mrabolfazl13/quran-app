/**
 * Arabic normalisation used by search, integrity checks and the memory engine.
 *
 * These functions are the single place where "the same word" is defined. The
 * Hifz error classifier, the mutashabihat index and the search index all agree
 * because they call into here — if they diverge, recall scores become fiction.
 */

/**
 * Combining marks and Quranic annotation signs, removed before comparison:
 * 0610-061A nasalisation, 064B-065F harakat/madd/standalone hamza,
 * 0670 superscript alef, 06D6-06ED small stop and observation signs,
 * 08D3-08FF extended Quranic marks, 0640 tatweel (elongation, not a letter).
 */
const DIACRITICS = new RegExp(
  `[${[
    '\\u0610-\\u061A',
    '\\u0640',
    '\\u064B-\\u065F',
    '\\u0670',
    '\\u06D6-\\u06ED',
    '\\u08D3-\\u08FF',
  ].join('')}]`,
  'g',
);

/** Alef family, including hamza carriers over alef. */
const ALEF_LIKE = /[أإٱآٲٳٵ]/g;

/**
 * Letters a Persian or Arabic keyboard produces for the same Quranic letter.
 * Deliberately narrow: each entry is one confirmed equivalence, never a range
 * that would silently swallow unrelated letters.
 */
const EQUIVALENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[ةۃ]/g, 'ه'], // ta marbuta / heh goal
  [/[ى]/g, 'ي'], // alef maqsura / ye
  [/[ک]/g, 'ك'], // Persian kehef / Arabic kaf
  [/[ؤ]/g, 'و'], // waw with hamza
  [/[ئ]/g, 'ي'], // ye with hamza
  [/[ۆ]/g, 'و'], // Persian oval waw
];

const ARABIC_DIGITS = /[٠-٩]/g;
const PERSIAN_DIGITS = /[۰-۹]/g;

/** Punctuation, symbols and invisibles — kept out of word keys in any script. */
const NON_WORD = /[\p{P}\p{S}\p{Cf}]/gu;

/**
 * Canonical form of a single recited or typed word.
 * Diacritics removed, alef/ya/ha unified, Persian digits folded.
 */
export function normalizeWord(input: string): string {
  let out = input.replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660));
  out = out.replace(PERSIAN_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0));
  out = out.replace(DIACRITICS, '');
  out = out.replace(ALEF_LIKE, 'ا');
  for (const [re, rep] of EQUIVALENTS) out = out.replace(re, rep);
  out = out.replace(NON_WORD, '');
  return out.replace(/\s+/g, '').trim();
}

/** Standalone ornamental ayah-ends and ayah-number signs. */
const STOP_MARK = /^[^\u0600-\u06FF]*$|[\u06DE\u06E9\u06DD\u066A\u066B\u066C]/;

/**
 * Split ayah text into word tokens. Empty tokens and pure ornamental marks are
 * dropped, so `position` is a stable 1-based word index.
 */
export function tokenizeWords(text: string): string[] {
  return text
    .split(/\s+/)
    .filter((raw) => raw.length > 0 && !isMarkOnly(raw))
    .map((raw) => raw.trim());
}

function isMarkOnly(token: string): boolean {
  if (STOP_MARK.test(token) && !/[ء-ي]/.test(token)) return true;
  return normalizeWord(token) === '';
}

/** Normalised, space-joined token string — the comparison basis. */
export function normalizedText(text: string): string {
  return tokenizeWords(text).map(normalizeWord).join(' ');
}

/** Word count of an ayah after token filtering. */
export function wordCount(text: string): number {
  return tokenizeWords(text).length;
}

/**
 * FNV-1a 64-bit over the normalised text, as 16 hex chars.
 * A content fingerprint for integrity diffs, not a security digest — pack
 * checksums use sha256 in the build pipeline.
 */
export function normalizedFingerprint(text: string): string {
  const s = normalizedText(text);
  let h = 0xcbf29ce484222325n;
  const p = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * p) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/** Levenshtein distance over token arrays; O(n·m). */
export function editDistance<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  const cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = cur.slice();
  }
  return prev[b.length]!;
}

/** Normalised similarity in 0..1 from edit distance over token arrays. */
export function tokenSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

/** Jaccard similarity over word sets — order-insensitive. */
export function setSimilarity(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Direction of the first strong character. Strings with no strong character
 * (digits, symbols, empty) are reported as LTR so callers must fall back to
 * the app's own base direction instead of guessing.
 */
export function isRtl(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) {
      return true;
    }
    if (/[A-Za-z\u0400-\u04ff\u3040-\u30ff\u4e00-\u9fff]/.test(ch)) return false;
  }
  return false;
}

/** Search key: normalised, lowercase, no diacritics — for both scripts. */
export function searchKey(text: string): string {
  return normalizedText(text).toLowerCase();
}
