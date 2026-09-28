/**
 * DISCOVER — mutashabihat (similar-ayat) browser.
 *
 * The pairs come from `gateway.similarTo()` — stored rows produced by the
 * blocking engine (`core/src/mutashabihat`). Their `textScore`, `sharedPhrase`
 * and `differingWords` are shown exactly as recorded; this screen never
 * recomputes or re-ranks a score. `producedBy` is rendered next to every
 * pair, per the provenance rule in `docs/mutashabihat.md`: these are
 * computed candidates, never scholarly claims.
 *
 * The word-level alignment is a display concern: shared vs differing is
 * decided with `normalizeWord` from `@quran/core` — the same pure function
 * the engine imports — and the raw Uthmani bytes are shown untouched.
 */
import { useState } from 'react';

import { normalizeWord, tokenizeWords } from '@quran/core';
import type { SimilarAyahPair, VerseKey } from '@quran/core';
import type { AyahWordRow } from '../../gateway/types';
import { useApp } from '../../app/app-state';
import type { RouteDef, RouteProps } from '../../app/router';
import { navigate } from '../../app/router';
import { StateBoundary, useAsync } from '../../ui/async';
import { Chip, Field, LinkButton, Panel } from '../../ui/primitives';
import './discover.css';

/** The list is capped at ten pairs, and the cap is stated in the UI. */
const PAIR_LIMIT = 10;

const VK_PATTERN = /^\d{1,3}:\d{1,3}$/;

interface PairView {
  pair: SimilarAyahPair;
  otherKey: VerseKey;
  otherText: string | null;
  otherWords: AyahWordRow[];
}

interface FocusView {
  verseKey: VerseKey;
  textUthmani: string;
  page: number;
  chapter: number;
  verse: number;
  words: AyahWordRow[];
  pairs: PairView[];
}

/** Word tokens for alignment: pack word rows when present, else the engine's tokenizer. */
function surfaceTokens(words: AyahWordRow[], text: string | null): string[] {
  const real = words.filter((w) => !w.isEndOfAyahMark);
  if (real.length > 0) return real.map((w) => w.textUthmani);
  return text === null ? [] : tokenizeWords(text);
}

export function MutashabihatScreen({ query }: RouteProps) {
  const { tr, gateway } = useApp();
  const rawVk = query['vk'] ?? '';
  const vk: VerseKey | null = VK_PATTERN.test(rawVk) ? (rawVk as VerseKey) : null;

  const focus = useAsync<FocusView | null>(
    async () => {
      if (!gateway || vk === null) return null;
      const ayah = await gateway.ayah(vk);
      if (!ayah) throw new Error(tr(`آیهٔ ${vk} در پایگاه داده نیست`, `ayah ${vk} is not in the database`));
      const words = await gateway.words(vk);
      const pairs = await gateway.similarTo(vk, PAIR_LIMIT);
      const views: PairView[] = [];
      for (const pair of pairs) {
        const otherKey = (pair.verseKeyA === vk ? pair.verseKeyB : pair.verseKeyA) as VerseKey;
        const [otherAyah, otherWords] = await Promise.all([gateway.ayah(otherKey), gateway.words(otherKey)]);
        views.push({ pair, otherKey, otherText: otherAyah?.textUthmani ?? null, otherWords });
      }
      return {
        verseKey: ayah.verseKey,
        textUthmani: ayah.textUthmani,
        page: ayah.page,
        chapter: ayah.chapter,
        verse: ayah.verse,
        words,
        pairs: views,
      };
    },
    [gateway, vk, tr],
  );

  if (vk === null) return <FocusPicker />;

  return (
    <StateBoundary
      state={focus}
      emptyTitle={tr('نامزد مشابهی ثبت نشده', 'No stored similar-ayah candidates')}
      emptyBody={tr(
        'برای این آیه جفتی در پایگاه دادهٔ مشابهت نیست: موتور فقط زوج‌هایی را ثبت می‌کند که از آستانهٔ امتیاز و حداقل کلمات مشترک عبور کنند. آیهٔ دیگری را انتخاب کنید.',
        'This ayah has no pair in the similarity store: the engine only records pairs that clear its score bar and shared-word minimum. Try another ayah.',
      )}
      isEmpty={(value) => value !== null && value.pairs.length === 0}
      onRetry={() => focus.refresh()}
    >
      {(value) => (value === null ? null : <Pairs view={value} />)}
    </StateBoundary>
  );
}

function Pairs({ view }: { view: FocusView }) {
  const { tr } = useApp();
  const focusTokens = surfaceTokens(view.words, view.textUthmani);
  const focusNorm = new Set(focusTokens.map(normalizeWord));
  return (
    <div className="stack">
      <Panel
        title={
          <span>
            {tr('آیهٔ محور', 'Focus ayah')} ·{' '}
            <LinkButton to={`/quran/ayah/${encodeURIComponent(view.verseKey)}`} className="mono num">
              {view.verseKey}
            </LinkButton>
          </span>
        }
        action={
          <div className="row">
            <Chip>{tr(`صفحهٔ ${view.page}`, `page ${view.page}`)}</Chip>
            <LinkButton to="/discover/mutashabihat">{tr('آیهٔ دیگر', 'Another ayah')}</LinkButton>
          </div>
        }
      >
        <p className="quran-text">{view.textUthmani}</p>
      </Panel>

      <p className="muted">
        {tr(
          `حداکثر ${PAIR_LIMIT} نامزد نخست نمایش داده می‌شود. این جفت‌ها مشابهت متنیِ محاسبه‌شده‌اند، نه ادعای علمی یا دینی؛ همان‌طور که موتور ثبت کرده نمایش داده می‌شوند.`,
          `Showing at most the first ${PAIR_LIMIT} candidates. These are computed textual similarities — not a scholarly or religious claim — presented exactly as the engine stored them.`,
        )}
      </p>

      <div className="legend">
        <span>
          <span className="legend__swatch legend__swatch--same" aria-hidden="true" />
          {tr('مشترک (با تعریف موتور)', 'shared (engine’s definition of same word)')}
        </span>
        <span>
          <span className="legend__swatch legend__swatch--diff" aria-hidden="true" />
          {tr('متمایز از طرف دیگر', 'not present on the other side')}
        </span>
      </div>

      <div className="pairs">
        {view.pairs.map((p) => (
          <PairCard
            key={`${p.pair.verseKeyA}|${p.pair.verseKeyB}`}
            view={p}
            focusKey={view.verseKey}
            focusTokens={focusTokens}
            focusNorm={focusNorm}
          />
        ))}
      </div>
    </div>
  );
}

function PairCard({
  view,
  focusKey,
  focusTokens,
  focusNorm,
}: {
  view: PairView;
  focusKey: VerseKey;
  focusTokens: string[];
  focusNorm: Set<string>;
}) {
  const { tr } = useApp();
  const otherTokens = surfaceTokens(view.otherWords, view.otherText);
  const otherNorm = new Set(otherTokens.map(normalizeWord));
  return (
    <article className="pair">
      <div className="row">
        <LinkButton to={`/quran/ayah/${encodeURIComponent(view.otherKey)}`} className="mono num">
          {view.otherKey}
        </LinkButton>
        <Chip tone="info" title={tr('امتیاز ذخیره‌شدهٔ موتور، بازمحاسبه نمی‌شود', 'stored engine score, never recomputed here')}>
          {`textScore ${view.pair.textScore.toFixed(4)}`}
        </Chip>
        {view.pair.sharedPhrase ? (
          <Chip>
            <span className="arabic-inline">{`${tr('عبارت مشترک', 'shared phrase')}: ${view.pair.sharedPhrase}`}</span>
          </Chip>
        ) : null}
        {view.pair.differingWords.map((word, i) => (
          <Chip key={`${word}-${i}`} tone="warn">
            <span className="arabic-inline">{word}</span>
          </Chip>
        ))}
        <Chip title={tr('سازندهٔ این جفت', 'what produced this pair')}>
          <span className="mono">{view.pair.producedBy}</span>
        </Chip>
      </div>

      <div className="alignment">
        <WordSide label={focusKey} tokens={focusTokens} otherNorm={otherNorm} role="focus" />
        <WordSide label={view.otherKey} tokens={otherTokens} otherNorm={focusNorm} role="similar" />
      </div>

      <div className="row">
        <LinkButton to="/hifz/confusion" className="btn btn--primary">
          {tr('بردن به گروه‌های ابهام', 'Open confusion groups')}
        </LinkButton>
        <span className="muted">
          {tr(
            'این فقط مشاهده است: هر دو آیه را به مجموعهٔ حفظ اضافه کنید تا همین جفت به تمرین تبدیل شود و موتور، الگوی اشتباه شما را ببیند.',
            'This is only an observation: add both ayat to your hifz set and this pair becomes a drill — the engine then learns your confusion pattern.',
          )}
        </span>
      </div>
    </article>
  );
}

function WordSide({
  label,
  tokens,
  otherNorm,
  role,
}: {
  label: VerseKey;
  tokens: string[];
  otherNorm: Set<string>;
  role: 'focus' | 'similar';
}) {
  const { tr } = useApp();
  return (
    <div className="alignment__side">
      <LinkButton to={`/quran/ayah/${encodeURIComponent(label)}`} className="mono num">
        {label}
      </LinkButton>
      <div className="wordline">
        {tokens.map((token, i) => (
          <span key={i} className={`word${otherNorm.has(normalizeWord(token)) ? '' : ' word--diff'}`}>
            {token}
          </span>
        ))}
      </div>
      <span className="faint">
        {role === 'focus' ? tr('آیهٔ محور', 'focus ayah') : tr('آیهٔ نامزد مشابه', 'candidate ayah')}
      </span>
    </div>
  );
}

/** No `?vk=` — pick a focus ayah from recent bookmarks or type a verse key. */
function FocusPicker() {
  const { tr, gateway } = useApp();
  const [vkInput, setVkInput] = useState('');
  const bookmarks = useAsync(
    async () => {
      if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
      const list = await gateway.bookmarks();
      return list
        .filter((b): b is typeof b & { verseKey: VerseKey } => b.verseKey !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 8);
    },
    [gateway, tr],
  );
  const vkOk = VK_PATTERN.test(vkInput.trim());
  return (
    <div className="stack">
      <Panel title={tr('آیهٔ محور را انتخاب کنید', 'Choose the focus ayah')}>
        <div className="stack--tight">
          <Field
            label={tr('کلید آیه (سوره:آیه)', 'Verse key (chapter:ayah)')}
            htmlFor="mutashabihat-vk"
            hint={tr('نمونه: ۲:۲۵۵ یا 55:76', 'Example: 2:255')}
          >
            <div className="row">
              <input
                id="mutashabihat-vk"
                className="input mono"
                dir="ltr"
                inputMode="numeric"
                value={vkInput}
                onChange={(e) => setVkInput(e.target.value)}
                placeholder="2:255"
              />
              <button
                type="button"
                className="btn btn--primary"
                disabled={!vkOk}
                onClick={() => {
                  if (vkOk) navigate(`/discover/mutashabihat?vk=${encodeURIComponent(vkInput.trim())}`);
                }}
              >
                {tr('نمایش مشابه‌ها', 'Show similar ayat')}
              </button>
            </div>
          </Field>
          <p className="muted">
            {tr(
              'از صفحهٔ خواندن هم می‌توان مستقیم رسید: پیوند «آیات مشابه» هر آیه همین مسیر را با ?vk= می‌سازد.',
              'Reader links arrive here directly: an ayah’s “similar ayat” link targets this route with ?vk=.',
            )}
          </p>
        </div>
      </Panel>

      <Panel title={tr('نشانک‌های اخیر', 'Recent bookmarks')}>
        <StateBoundary
          state={bookmarks}
          emptyTitle={tr('نشانکی با آیه ثبت نشده', 'No bookmark points at an ayah yet')}
          emptyBody={tr(
            'هنگام خواندن، آیاتی که برایتان مهم‌اند را نشانک کنید تا اینجا فهرست شوند.',
            'Bookmark ayat while reading and they will be offered here.',
          )}
          isEmpty={(list) => list.length === 0}
          onRetry={() => bookmarks.refresh()}
        >
          {(list) => (
            <ul className="list">
              {list.map((b) => (
                <li key={b.id}>
                  <LinkButton to={`/discover/mutashabihat?vk=${encodeURIComponent(b.verseKey)}`} className="mono num">
                    {b.verseKey}
                  </LinkButton>
                  {b.label ? <span className="muted"> — {b.label}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </StateBoundary>
      </Panel>
    </div>
  );
}

export const routes: readonly RouteDef[] = [
  {
    path: '/discover/mutashabihat',
    title: (t) => t('آیات مشابه (متشابهات)', 'Similar ayat (mutashabihat)'),
    section: 'discover',
    component: MutashabihatScreen,
  },
];
