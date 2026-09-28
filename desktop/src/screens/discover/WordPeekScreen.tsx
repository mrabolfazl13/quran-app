/**
 * DISCOVER — word peek (optional deep link).
 *
 * `/discover/word/:chapter/:position` addresses the position-th word of a
 * surah (1-based, over the engine's filtered token stream, matching
 * `AyahWord.position` semantics): the containing ayah is found by walking
 * stored `wordCount` values, so exactly one ayah's word rows are fetched.
 *
 * Everything shown is stored pack data — root, morphology, gloss,
 * transliteration — or a real `search()` result. When the pack carries no
 * root for a word the screen says so; it never guesses one. Occurrences are
 * found by searching the root's letters (roots are spaced, e.g. `ر ح م`;
 * `normalizeWord` folds that to the same key as `رحم`), capped and labelled.
 */
import type { AyahRow, AyahWordRow, SearchHit } from '../../gateway/types';
import type { Surah } from '@quran/core';
import { useApp } from '../../app/app-state';
import type { RouteDef, RouteProps } from '../../app/router';
import { StateBoundary, useAsync } from '../../ui/async';
import { Chip, LinkButton, Panel } from '../../ui/primitives';
import { normalizeWord } from '@quran/core';
import './discover.css';

const OCCURRENCE_LIMIT = 20;

interface WordView {
  surah: Surah;
  ayah: AyahRow | null;
  word: AyahWordRow | null;
  /** Surah-wide index of the found word, for context in the header. */
  position: number;
  occurrences: SearchHit[] | null;
}

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function WordPeekScreen({ params }: RouteProps) {
  const { tr, gateway } = useApp();
  const chapter = positiveInt(params['chapter']);
  const position = positiveInt(params['position']);

  const state = useAsync<WordView | null>(
    async () => {
      if (!gateway || chapter === null || position === null) return null;
      const surah = await gateway.surah(chapter);
      if (!surah) return null;
      const ayahs = await gateway.ayahsByChapter(chapter);
      let remaining = position;
      let ayah: AyahRow | null = null;
      for (const candidate of ayahs) {
        if (remaining <= candidate.wordCount) {
          ayah = candidate;
          break;
        }
        remaining -= candidate.wordCount;
      }
      if (!ayah) return { surah, ayah: null, word: null, position, occurrences: null };
      const words = await gateway.words(ayah.verseKey);
      const word = words.find((w) => !w.isEndOfAyahMark && w.position === remaining) ?? null;
      let occurrences: SearchHit[] | null = null;
      if (word && word.root) {
        const rootKey = normalizeWord(word.root);
        occurrences =
          rootKey.length > 0
            ? await gateway.search(rootKey, { field: 'arabic', limit: OCCURRENCE_LIMIT })
            : [];
      }
      return { surah, ayah, word, position, occurrences };
    },
    [gateway, chapter, position, tr],
  );

  if (chapter === null || position === null) {
    return <BadAddress chapter={chapter} position={position} />;
  }

  return (
    <StateBoundary
      state={state}
      emptyTitle={tr('این واژه پیدا نشد', 'This word was not found')}
      emptyBody={tr(
        'شمارهٔ سوره یا جایگاه واژه با دادهٔ واردشده مطابقت ندارد. جایگاه واژه از ۱ تا شمار واژه‌های سوره است.',
        'The chapter number or word position does not match the imported data. Positions run from 1 to the surah’s word count.',
      )}
      emptyAction={<LinkButton to="/discover">{tr('بازگشت به جستجو', 'Back to search')}</LinkButton>}
      isEmpty={(view) => view === null || view.word === null}
      onRetry={() => state.refresh()}
    >
      {(view) => (view && view.word ? <WordCard view={view} /> : null)}
    </StateBoundary>
  );
}

function BadAddress({ chapter, position }: { chapter: number | null; position: number | null }) {
  const { tr } = useApp();
  return (
    <div className="state state--error" role="alert">
      <h3>{tr('نشانی واژه معتبر نیست', 'This word address is not valid')}</h3>
      <p className="muted mono">{`/discover/word/${chapter ?? ':chapter'}/${position ?? ':position'}`}</p>
      <p className="muted">
        {tr('هر دو جزء باید عدد صحیح مثبت باشند (سورهٔ ۱ تا ۱۱۴).', 'Both parts must be positive integers (chapter 1–114).')}
      </p>
      <LinkButton to="/discover">{tr('بازگشت به جستجو', 'Back to search')}</LinkButton>
    </div>
  );
}

function WordCard({ view }: { view: WordView }) {
  const { tr } = useApp();
  const word = view.word;
  const ayah = view.ayah;
  if (word === null || ayah === null) return null;
  return (
    <div className="stack">
      <Panel
        title={
          <span>
            {`${tr('واژه', 'Word')} ${view.position}`} · {view.surah.nameTransliterated}
          </span>
        }
        action={
          <LinkButton to={`/quran/ayah/${encodeURIComponent(ayah.verseKey)}`} className="mono num">
            {ayah.verseKey}
          </LinkButton>
        }
      >
        <div className="wordcard">
          <p className="quran-text wordcard__text">{word.textUthmani}</p>
          <div className="row">
            {word.root ? (
              <Chip tone="accent" title={tr('ریشه از بستهٔ واژگان', 'root from the word pack')}>
                <span className="arabic-inline">{`${tr('ریشه', 'root')}: ${word.root}`}</span>
              </Chip>
            ) : (
              <Chip tone="warn" title={tr('بستهٔ فعلی ریشهٔ این واژه را ندارد؛ موتور ریشه حدس نمی‌زند', 'the pack carries no root for this word; nothing is guessed')}>
                {tr('ریشه در بسته نیست', 'no root in pack')}
              </Chip>
            )}
            {word.morphology ? (
              <Chip>
                <span className="mono">{word.morphology}</span>
              </Chip>
            ) : null}
            {word.transliteration ? <Chip>{word.transliteration}</Chip> : null}
            <Chip>{tr(`صفحهٔ ${word.pageNumber}، سطر ${word.lineNumber}`, `page ${word.pageNumber}, line ${word.lineNumber}`)}</Chip>
          </div>
          {word.translationEn ? <p className="muted">{word.translationEn}</p> : null}
        </div>
      </Panel>

      {word.root ? (
        <Panel title={tr('گونه‌های همین ریشه در مصحف', 'Occurrences of this root in the mushaf')}>
          {view.occurrences === null ? (
            <p className="muted">{tr('در حال جستجو…', 'Searching…')}</p>
          ) : view.occurrences.length === 0 ? (
            <p className="muted">{tr('نتیجه‌ای از راه جستجو پیدا نشد.', 'The search found nothing for this root.')}</p>
          ) : (
            <div className="stack--tight">
              <p className="muted" role="status" aria-live="polite">
                {tr(
                  `نمایش ${view.occurrences.length} نتیجهٔ نخست (حداکثر ${OCCURRENCE_LIMIT}) از جستجوی letters ریشه`,
                  `Showing ${view.occurrences.length} first result${view.occurrences.length === 1 ? '' : 's'} (cap ${OCCURRENCE_LIMIT}) of searching the root letters`,
                )}
              </p>
              <ul className="list">
                {view.occurrences.map((hit) => (
                  <li key={`${hit.verseKey}|${hit.field}`}>
                    <LinkButton to={`/quran/ayah/${encodeURIComponent(hit.verseKey)}`} className="mono num">
                      {hit.verseKey}
                    </LinkButton>
                    <span className="arabic-inline"> {hit.textUthmani.slice(0, 80)}{hit.textUthmani.length > 80 ? '…' : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      ) : (
        <p className="muted">
          {tr(
            'بدون ریشه، بخش «گونه‌های ریشه» نمایش داده نمی‌شود: جستجو فقط روی حرف‌های ریشهٔ واقعی معنا دارد و ما ریشهٔ حدسی را جستجو نمی‌کنیم.',
            'With no stored root, the root-occurrences section is not rendered: that search only means something over real root letters, and we do not search guesses.',
          )}
        </p>
      )}
    </div>
  );
}

export const routes: readonly RouteDef[] = [
  {
    path: '/discover/word/:chapter/:position',
    title: (t) => t('واژه', 'Word'),
    section: 'discover',
    component: WordPeekScreen,
  },
];
