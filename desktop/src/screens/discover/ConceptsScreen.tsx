/**
 * DISCOVER — concept browser.
 *
 * Honest-state screen. The schema (`concept`, `concept_ayah`,
 * `concept_relation` in `core/src/contracts/db.sql`) and the import path
 * (`ContentPlan.concepts` in the gateway) are in place, and `counts()`
 * reports how many concept rows the database actually holds — but no
 * shipped content pack carries concept records yet, and `DataGateway`
 * exposes no concept read method today.
 *
 * So: if a future gateway grows `concepts()`, this screen renders from it
 * (detected at call time, never guessed). Otherwise it explains exactly
 * what exists and what does not, and points at the word-level root and
 * morphology data that IS already shipped. Inventing Quranic scholarly
 * content is the one unforgivable error in this project — nothing here is
 * fabricated, and the only number shown is `counts().concepts`.
 */
import type { Concept } from '@quran/core';
import type { DataGateway } from '../../gateway/types';
import { useApp } from '../../app/app-state';
import type { RouteDef, RouteProps } from '../../app/router';
import { StateBoundary, useAsync } from '../../ui/async';
import { Chip, LinkButton, Panel } from '../../ui/primitives';
import './discover.css';

/** The read this screen would need; absent from DataGateway until it lands. */
interface ConceptRead {
  concepts?(): Promise<Concept[]>;
}

interface ConceptView {
  /** `counts().concepts` — stored concept rows, the only number on screen. */
  storedRows: number;
  /** Rows from a gateway concept read, or null when no such method exists. */
  rows: Concept[] | null;
}

function isConcept(value: unknown): value is Concept {
  const row = value as Partial<Concept> | null;
  return (
    row !== null &&
    typeof row === 'object' &&
    typeof row.id === 'string' &&
    typeof row.labelEn === 'string' &&
    typeof row.labelFa === 'string' &&
    typeof row.labelArabic === 'string'
  );
}

export function ConceptsScreen(_props: RouteProps) {
  const { tr, gateway } = useApp();
  const state = useAsync<ConceptView>(
    async () => {
      if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
      const counts = await gateway.counts();
      const reader = gateway as DataGateway & ConceptRead;
      const rows = typeof reader.concepts === 'function' ? (await reader.concepts()).filter(isConcept) : null;
      return { storedRows: counts.concepts, rows };
    },
    [gateway, tr],
  );

  return (
    <StateBoundary
      state={state}
      emptyTitle={tr('چیزی نیست', 'Nothing to show')}
      isEmpty={() => false}
      onRetry={() => state.refresh()}
    >
      {(view) => (view.rows !== null && view.rows.length > 0 ? <ConceptList rows={view.rows} /> : <WhyEmpty storedRows={view.storedRows} hasReader={view.rows !== null} />)}
    </StateBoundary>
  );
}

function ConceptList({ rows }: { rows: Concept[] }) {
  const { tr, lang } = useApp();
  return (
    <div className="stack">
      <p className="muted" role="status" aria-live="polite">
        {tr(`نمایش ${rows.length} مفهوم از بستهٔ مفهوم`, `Showing ${rows.length} concepts from the installed concept pack`)}
      </p>
      <ul className="hits">
        {rows.map((concept) => (
          <li className="hit" key={concept.id}>
            <div className="row">
              <span className="arabic-inline">{concept.labelArabic}</span>
              <span>{lang === 'en' ? concept.labelEn : concept.labelFa}</span>
              <Chip tone={concept.relationType === 'explicit' ? 'accent' : 'warn'} title={tr('نوع رابطه — تنها explicit منبعی است، آن هم از بستهٔ مجاز', 'only explicit links are authority, and only from a licensed pack')}>
                {concept.relationType}
              </Chip>
            </div>
            {concept.descriptionFa ? <p className="muted persian">{concept.descriptionFa}</p> : null}
            <Chip title={tr('سازندهٔ رکورد', 'record producer')}>
              <span className="mono">{concept.producedBy}</span>
            </Chip>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WhyEmpty({ storedRows, hasReader }: { storedRows: number; hasReader: boolean }) {
  const { tr } = useApp();
  return (
    <div className="stack">
      <Panel title={tr('لایهٔ مفهوم', 'The concept layer')}>
        <div className="stack--tight">
          <p className="muted">
            {tr(
              'این صفحه دربارهٔ پیوند «مفهوم → آیات» است (مثلاً صبر در سراسهٔ مصحف) — کاری که موتور متشابهات انجام نمی‌دهد، چون مفهوم‌ها معنایند نه توالی واژگان.',
              'This screen is about concept-to-ayah links (e.g. patience across the mushaf) — the mutashabihat engine deliberately does not do this, because concepts are meaning, not word sequence.',
            )}
          </p>
          <ul className="list">
            <li>
              {tr(
                'زیرساخت آماده است: جدول‌های concept، concept_ayah و concept_relation در طرح پایگاه تعریف شده‌اند و واردکنندهٔ بسته‌ها آن‌ها را می‌نویسد.',
                'The plumbing is ready: the concept, concept_ayah and concept_relation tables exist in the schema and the pack importer writes them.',
              )}
            </li>
            <li>
              {hasReader ? (
                tr(
                  'خواندن مفهوم در دسترس است اما هیچ رکوردی برنگشت.',
                  'A concept read is available but returned no rows.',
                )
              ) : (
                tr(
                  'هنوز هیچ بستهٔ محتواییِ دارایِ مفهوم نصب نشده، و دروازهٔ داده هم روش خواندن مفهوم ندارد؛ بنابراین اینجا چیزی برای نمایش نیست و چیزی ساخته نمی‌شود.',
                  'No concept-bearing content pack is installed, and the data gateway exposes no concept read either; so there is nothing to display — and nothing will be invented.',
                )
              )}
            </li>
            <li>
              <span className="mono num">{`counts().concepts = ${storedRows}`}</span>
              {tr(' — شمار رکوردهای مفهوم در پایگاه؛ تنها عدد روی این صفحه.', ' — stored concept rows; the only number on this screen.')}
            </li>
          </ul>
          {storedRows > 0 ? (
            <p className="muted">
              {tr(
                'با این حال تعدادی رکورد مفهوم در پایگاه هست؛ تا زمانی که دروازهٔ داده روش خواندنِ type‌شدهٔ آن‌ها را ارائه نکند، این صفحه شکل داده را حدس نمی‌زند.',
                'Concept rows are present in the database; until the gateway exposes a typed read for them, this screen will not guess at their shape.',
              )}
            </p>
          ) : null}
        </div>
      </Panel>

      <Panel title={tr('الان چه چیزی قابل کاوش است', 'What you can explore today')}>
        <div className="stack--tight">
          <p className="muted">
            {tr(
              'دادهٔ سطح واژه (ریشه، صرف، ترجمهٔ واژه) در بستهٔ مصحف موجود است: از جزئیات واژه‌های هر سوره ببینید یا در جستجو ریشه بیابید.',
              'Word-level data (root, morphology, per-word gloss) does ship in the mushaf pack: browse a surah’s word detail, or search root letters.',
            )}
          </p>
          <div className="row">
            <LinkButton to="/quran/surah/2" className="btn btn--primary">
              {tr('جزئیات واژه‌های سوره', 'Surah word detail')}
            </LinkButton>
            <LinkButton to="/discover" className="btn">
              {tr('جستجو', 'Search')}
            </LinkButton>
          </div>
        </div>
      </Panel>
    </div>
  );
}

export const routes: readonly RouteDef[] = [
  {
    path: '/discover/concepts',
    title: (t) => t('مفهوم‌ها', 'Concepts'),
    section: 'discover',
    component: ConceptsScreen,
  },
];
