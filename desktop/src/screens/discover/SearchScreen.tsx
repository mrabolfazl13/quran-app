/**
 * DISCOVER — search.
 *
 * The query is handed to the gateway verbatim; every backend in
 * `gateway/search.ts` normalises it with `tokenizeWords` + `normalizeWord`
 * from `@quran/core`, so this screen never pre-normalises the input either.
 * The excerpt highlight reuses that same definition of "same word": a token
 * is marked when its `normalizeWord` form (or its lowercased latin form)
 * equals one of the query's — raw display bytes are never rewritten.
 *
 * The backend that answered (`searchBackend()`) is always rendered, and the
 * gateway's note (`searchBackendNote()`) is rendered beside it through
 * `searchNote`: they are how a reviewer knows which search path produced the
 * list. The gateway reports an id, this screen owns the wording. This screen
 * only labels paths a gateway can actually report today — it never advertises
 * one it does not run (see `backendLabel`).
 */
import { useEffect, useState, type ReactNode } from 'react';

import { normalizeWord, tokenizeWords } from '@quran/core';
import type { SearchHit } from '../../gateway/types';
import type { SearchBackend, SearchNoteId } from '../../gateway/types';
import { useApp } from '../../app/app-state';
import { shellSentence } from '../../app/labels';
import type { RouteDef, RouteProps } from '../../app/router';
import { StateBoundary, useAsync } from '../../ui/async';
import { searchNote } from '../../ui/gatewayText';
import { Chip, Field, LinkButton, Panel } from '../../ui/primitives';
import './discover.css';

/** The list is capped, and the cap is stated in the UI. */
const RESULT_LIMIT = 50;
const DEBOUNCE_MS = 200;

type FieldChoice = 'all' | SearchHit['field'];

const FIELD_CHOICES: readonly FieldChoice[] = ['all', 'arabic', 'translation-en', 'translation-fa'];

function fieldLabel(tr: (fa: string, en: string) => string, choice: FieldChoice): string {
  switch (choice) {
    case 'all':
      return tr('همهٔ زمینه‌ها', 'All fields');
    case 'arabic':
      return tr('عربی (متن مصحف)', 'Arabic (mushaf text)');
    case 'translation-en':
      return tr('ترجمهٔ انگلیسی', 'English translation');
    case 'translation-fa':
      return tr('ترجمهٔ فارسی', 'Persian translation');
  }
}

/**
 * The label for the path that actually answered.
 *
 * Three backends can be reported by a gateway today: `sqlite-fts5` and `like`
 * from the Tauri gateway, `memory-index` from the browser build (web and dev
 * shell). The
 * `core-engine` id is *not* one of them — `CoreEngineSearchService` in
 * `gateway/search.ts` is implemented but wired by no gateway — so this screen
 * makes no claim about it. Should a gateway start reporting it, the raw id is
 * echoed as a report rather than dressed up as a feature this screen verified.
 *
 * The gateway note is a separate sentence about *which* path answered, and it
 * arrives as an id — the wording is this screen's, translated in
 * `ui/gatewayText.ts`, so nothing below the language boundary can put English
 * into a Persian page.
 */
function backendLabel(tr: (fa: string, en: string) => string, backend: SearchBackend): string {
  switch (backend) {
    case 'sqlite-fts5':
      return tr('جستجوی کامل متن SQLite (FTS5)', 'SQLite full-text search (FTS5)');
    case 'like':
      return tr('مطابق‌سازی ساده، بدون FTS5', 'plain LIKE matching, no FTS5');
    case 'memory-index':
      return tr('نمایهٔ در حافظهٔ همین صفحه', 'in-memory index in this page');
    default:
      return tr('این مسیر را خودِ دروازهٔ داده گزارش می‌کند؛ این صفحه برایش برچسبی نمی‌سازد', 'reported by the data gateway itself; this screen invents no label for it');
  }
}

/**
 * Mark the query's words inside the excerpt. Comparison follows the
 * engine's own rule (`normalizeWord` over `tokenizeWords`); for latin text
 * also the case-folded token, because the search module keeps a separate
 * documented Latin path that `normalizeWord` deliberately ignores.
 */
function highlight(text: string, query: string): ReactNode {
  const queryNorm = new Set(tokenizeWords(query).map(normalizeWord).filter((t) => t.length > 0));
  const queryRaw = new Set(
    tokenizeWords(query)
      .map((t) => t.replace(/[\p{P}\p{S}]/gu, '').toLowerCase())
      .filter((t) => t.length > 1),
  );
  if (queryNorm.size === 0 && queryRaw.size === 0) return text;
  const parts = text.split(/(\s+)/);
  return parts.map((part, i) => {
    if (part.length === 0 || /^\s+$/.test(part)) return part;
    const norm = normalizeWord(part);
    const latin = part.replace(/[\p{P}\p{S}]/gu, '').toLowerCase();
    const hit = (norm.length > 0 && queryNorm.has(norm)) || (latin.length > 1 && queryRaw.has(latin));
    return hit ? (
      <span className="mark" key={i}>
        {part}
      </span>
    ) : (
      part
    );
  });
}

interface SearchView {
  hits: SearchHit[];
  backend: SearchBackend;
  note: SearchNoteId | null;
}

/** Tokens drawn from the actual corpus — the empty-query suggestions. */
interface SampleQueries {
  /** Raw surface words, safe to run as queries verbatim. */
  tokens: string[];
  hasAnyAyah: boolean;
}

export function SearchScreen({ query: routeQuery }: RouteProps) {
  const { tr, gateway, info } = useApp();
  // `#/discover?q=…` is a real address for a real result list: a shared verse
  // search, a cross-link from the mutashabihat screen or a browser back has to
  // land on the answers, not on an empty box. The screen used to take `RouteProps`
  // and ignore it, which made every deep link into an idle form.
  const requested = (routeQuery.q ?? '').trim();
  const [rawQuery, setRawQuery] = useState(requested);
  const [field, setField] = useState<FieldChoice>('all');
  const [query, setQuery] = useState(requested);

  useEffect(() => {
    // Only when the address says something new. A dependency on `requested` alone
    // means typing — which changes the box, not the URL — cannot be overwritten.
    setRawQuery(requested);
  }, [requested]);

  useEffect(() => {
    const id = window.setTimeout(() => setQuery(rawQuery.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [rawQuery]);

  const search = useAsync<SearchView>(
    async () => {
      if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
      const [hits, backend, note] = await Promise.all([
        query.length === 0
          ? Promise.resolve<SearchHit[]>([])
          : gateway.search(query, { field: field === 'all' ? undefined : field, limit: RESULT_LIMIT }),
        gateway.searchBackend(),
        gateway.searchBackendNote?.() ?? Promise.resolve(null),
      ]);
      return { hits, backend, note };
    },
    [gateway, query, field, tr],
  );

  const samples = useAsync<SampleQueries>(
    async () => {
      if (!gateway) return { tokens: [], hasAnyAyah: false };
      // A few chapters' worth of ayah text; the suggestions are the engine's
      // own tokens (tokenizeWords → normalizeWord), never hard-coded hits.
      const ayahs = [...(await gateway.ayahsByChapter(1)), ...(await gateway.ayahsByChapter(112))];
      const seen = new Set<string>();
      const tokens: string[] = [];
      for (const ayah of ayahs) {
        for (const surface of tokenizeWords(ayah.textUthmani)) {
          const norm = normalizeWord(surface);
          if (norm.length < 3 || seen.has(norm)) continue;
          seen.add(norm);
          tokens.push(surface);
          if (tokens.length >= 6) return { tokens, hasAnyAyah: ayahs.length > 0 };
        }
      }
      return { tokens, hasAnyAyah: ayahs.length > 0 };
    },
    [gateway],
  );

  const value = search.value;
  const showingResults = query.length > 0;

  return (
    <div className="stack">
      <Panel title={tr('جستجو در آیات و ترجمه‌ها', 'Search the ayat and translations')}>
        <div className="stack--tight">
          <Field label={tr('عبارت جستجو', 'Search query')} htmlFor="discover-query">
            <input
              id="discover-query"
              className="input"
              type="search"
              dir="auto"
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              placeholder={tr('مثلاً رحمت …', 'e.g. mercy …')}
              autoComplete="off"
              aria-label={tr('عبارت جستجو', 'Search query')}
            />
          </Field>
          <Field label={tr('زمینهٔ جستجو', 'Search field')} htmlFor="discover-field">
            <select
              id="discover-field"
              className="select"
              value={field}
              onChange={(e) => setField(e.target.value as FieldChoice)}
            >
              {FIELD_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {fieldLabel(tr, choice)}
                </option>
              ))}
            </select>
          </Field>
          {value ? (
            <div className="backend-line" data-testid="search-backend">
              <Chip tone="info" title={tr('کدام مسیر جستجو پاسخ داد', 'Which search path answered')}>
                {`${tr('پاسخ از', 'answered by')}: `}
                <span className="mono">{value.backend}</span>
              </Chip>
              <span className="muted">{backendLabel(tr, value.backend)}</span>
              {/* Which gateway answered, in its own words: the dev shell and the
                  shipped SQLite path have different guarantees. */}
              {info ? (
                <span className="faint">{shellSentence(tr, info.mode)}</span>
              ) : null}
              {value.note ? <span className="faint">{searchNote(tr, value.note)}</span> : null}
            </div>
          ) : null}
        </div>
      </Panel>

      <StateBoundary
        state={search}
        emptyTitle={tr('نتیجه‌ای نیست', 'No results')}
        isEmpty={() => false}
        onRetry={() => search.refresh()}
      >
        {(view) => (
          <div className="stack">
            <p className="muted" role="status" aria-live="polite">
              {showingResults
                ? view.hits.length === 0
                  ? tr('نتیجه‌ای یافت نشد', 'No results found')
                  : tr(
                      `نمایش ${view.hits.length} نتیجه${view.hits.length === RESULT_LIMIT ? ` (حداکثر ${RESULT_LIMIT} نخست)` : ''}`,
                      `Showing ${view.hits.length} result${view.hits.length === 1 ? '' : 's'}${
                        view.hits.length === RESULT_LIMIT ? ` (first ${RESULT_LIMIT} only)` : ''
                      }`,
                    )
                  : tr('برای جستجو بنویسید.', 'Type to search.')}
            </p>

            {showingResults && view.hits.length === 0 ? <NoResults field={field} onSearchAll={() => setField('all')} /> : null}

            {!showingResults ? (
              <SuggestionPanel samples={samples} onPick={(token) => setRawQuery(token)} />
            ) : (
              <ul className="hits">
                {view.hits.map((hit) => (
                  <li className="hit" key={`${hit.verseKey}|${hit.field}`}>
                    <div className="row">
                      <LinkButton to={`/quran/ayah/${encodeURIComponent(hit.verseKey)}`} className="mono num">
                        {hit.verseKey}
                      </LinkButton>
                      <Chip>{tr(`سورهٔ ${hit.chapter}`, `surah ${hit.chapter}`)}</Chip>
                      <Chip>{tr(`آیهٔ ${hit.verse}`, `ayah ${hit.verse}`)}</Chip>
                      <Chip>{tr(`صفحهٔ ${hit.page}`, `page ${hit.page}`)}</Chip>
                      <Chip tone="accent">{fieldLabel(tr, hit.field)}</Chip>
                    </div>
                    <p className={`hit__excerpt${hit.field === 'arabic' ? ' hit__excerpt--arabic' : ''}`}>
                      {highlight(hit.excerpt, query)}
                    </p>
                    {hit.field !== 'arabic' ? <p className="quran-text hit__excerpt">{hit.textUthmani}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </StateBoundary>
    </div>
  );
}

function NoResults({ field, onSearchAll }: { field: FieldChoice; onSearchAll: () => void }) {
  const { tr } = useApp();
  const other = field === 'translation-fa' ? 'translation-en' : 'translation-fa';
  return (
    <div className="state state--empty">
      <h3>{tr('هیچ آیه‌ای با این عبارت مطابقت نکرد', 'No ayah matched this query')}</h3>
      <p className="muted">
        {field === 'all'
          ? tr(
              'جستجو روی متن عربی و هر دو ترجمه انجام شد. املا و اعراب را بررسی کنید؛ تطبیق قطعی است، نه معنایی.',
              'Arabic and both translations were searched. Matching is deterministic, not semantic — check the spelling and diacritics-free stem.',
            )
          : tr(
              `جستجو فقط در «${fieldLabel(tr, field)}» بود. زمینه‌های دیگر را هم امتحان کنید.`,
              `The search was restricted to "${fieldLabel(tr, field)}". Try the other fields.`,
            )}
      </p>
      {field !== 'all' ? (
        <div className="row">
          <button type="button" className="btn" onClick={onSearchAll}>
            {tr('جستجو در همهٔ زمینه‌ها', 'Search all fields')}
          </button>
          <span className="muted">{tr(`یا زمینهٔ «${fieldLabel(tr, other)}» را برگزینید.`, `Or pick the "${fieldLabel(tr, other)}" field.`)}</span>
        </div>
      ) : null}
    </div>
  );
}

function SuggestionPanel({
  samples,
  onPick,
}: {
  samples: { status: string; value: SampleQueries | null; error: unknown };
  onPick: (token: string) => void;
}) {
  const { tr } = useApp();
  const data = samples.value;
  return (
    <Panel title={tr('از کجا شروع کنم؟', 'Where to start?')}>
      {samples.status === 'loading' ? (
        <p className="muted">{tr('خواندن نمونه‌ها…', 'Reading samples…')}</p>
      ) : data && data.tokens.length > 0 ? (
        <div className="stack--tight">
          <p className="muted">
            {tr(
              'این نمونه‌ها واژه‌های خودِ مصحف‌اند (توکن‌های نرمال‌شدهٔ موتور). روی هر کدام بزنید تا جستجو شود:',
              'These are words from the mushaf itself (the engine’s own normalised tokens). Click one to search it:',
            )}
          </p>
          <div className="row">
            {data.tokens.map((token) => (
              <button
                key={token}
                type="button"
                className="btn btn--ghost quran-text"
                onClick={() => onPick(token)}
                aria-label={tr(`جستجوی ${token}`, `search ${token}`)}
              >
                {token}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="muted">
          {data && data.hasAnyAyah
            ? tr('نمونهٔ قابل‌نمایشی پیدا نشد.', 'No displayable sample was found.')
            : tr(
                'هنوز محتوایی وارد نشده است؛ برای فعال شدن جستجو نخست بسته‌های محتوا را وارد کنید.',
                'No content has been imported yet — import the content packs to enable search.',
              )}
        </p>
      )}
    </Panel>
  );
}

export const routes: readonly RouteDef[] = [
  {
    path: '/discover',
    title: (t) => t('جستجو و کاوش', 'Search & discover'),
    section: 'discover',
    component: SearchScreen,
  },
];
