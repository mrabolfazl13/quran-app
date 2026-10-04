/**
 * tests/e2e/journey.mjs — the user journey docs/testing.md promises, in order.
 *
 * open → Quran → surah → ayah → translation → tafsir → bookmark → note →
 * add to hifz → recall → seeded error → weak review → similar ayah →
 * confusion group → backup → restore → verify the ayah is still weak in exactly
 * the way it was.
 *
 * Rules this file is written under:
 *  - Every write to the app goes through the DOM a user uses (buttons, radios,
 *    textareas). The SQLite file / IndexedDB are opened read-only and are only
 *    ever the WITNESS, never the instrument.
 *  - Every assertion states its expected value, and where the expected value is
 *    computed it is computed from `content/index.json` or from the app's own
 *    stored rows — never from a number typed in beside a screenshot.
 *  - Each step carries the evidence level of what it proves. A step that can only
 *    run at desktop level says so and is recorded as SKIP elsewhere, not faked.
 *
 * Persian labels are copied from the screen sources; each is credited in a
 * comment so a wording change in the UI is findable from the failure message.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { eq, is, ok, includes, AssertionError } from './lib/harness.mjs';
import { dataChecksum, canonicalJsonStringify, faNumber } from './lib/expected.mjs';
import { PackSource } from './lib/packs.mjs';

/** Loading state marker used by `ui/async.tsx` (`.state--loading`). */
const LOADING = `!!document.querySelector('.state--loading')`;

/** Text of a button-like control, matched by regex source (Persian | English). */
const hasButton = (regexSource) =>
  `(function(){const re=new RegExp(${JSON.stringify(regexSource)});return Array.from(document.querySelectorAll('button, a.linkbtn')).some((b)=>re.test((b.textContent||'').trim())||re.test(b.title||''));})()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Collapse runs of whitespace: the reader and the DB differ only in spacing. */
const flatten = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export async function runJourney(ctx) {
  const { cdp, suite, expected, store, opts } = ctx;
  const step = (name, level, fn, extra = {}) => suite.step(name, level, () => fn(), extra);

  /**
   * Which of the four states a screen is actually in. `ui/async.tsx` renders
   * `.state--loading`, `.state--error` and `.state--empty`, so a wait that only
   * looks for "no spinner" cannot tell a rendered screen from a screen that
   * failed and is showing its error panel. Anything that reaches a timeout here
   * reports the app's own words rather than a selector that did not appear.
   */
  const screenState = (selector) =>
    cdp
      .evaluate(`(function(){
        const flat = (el) => (el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null);
        return JSON.stringify({
          hash: location.hash,
          error: flat(document.querySelector('.state--error')),
          empty: flat(document.querySelector('.state--empty')),
          loading: !!document.querySelector('.state--loading'),
          target: !!document.querySelector(${JSON.stringify(selector)}),
          body: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
        });
      })()`)
      .then((raw) => JSON.parse(String(raw)));

  /** Wait for `selector`, or stop at the first state that is already an answer. */
  const settleOn = async (label, selector, { timeoutMs = 90_000 } = {}) => {
    const from = Date.now();
    for (;;) {
      const state = await screenState(selector);
      if (state.target) return { ...state, waitedMs: Date.now() - from };
      if (state.error) {
        // An error panel is a finished answer, not a slow one. Polling past it
        // recorded a timeout on top of the real failure and hid which route the
        // app had actually landed on.
        throw new Error(`${label} rendered an error state · at ${state.hash} · ${state.error.slice(0, 240)}`);
      }
      if (!state.loading && state.empty) return { ...state, waitedMs: Date.now() - from };
      if (Date.now() - from >= timeoutMs) {
        throw new Error(`${label} never rendered within ${timeoutMs} ms · at ${state.hash} · loading=${state.loading} · on screen: ${state.body}`);
      }
      await sleep(500);
    }
  };

  /* ------------------------------------------------------------------ open */

  await step('app launches and exposes its window over CDP', 'device', async () => {
    // The CDP target exists before the document has a title, so reading it once
    // is a race the runner sometimes loses (a 6 ms "empty title" that was really
    // a page still booting). Wait for the app to answer, then measure.
    await cdp.waitFor(`(function(){const r=document.getElementById('root');return !!r && r.children.length>0 && document.title.length>0;})()`, {
      timeoutMs: 90_000,
      label: 'the window to boot and name itself',
    });
    const title = await cdp.evaluate('document.title');
    ok(typeof title === 'string' && title.length > 0, 'window has a title', title);
    const url = await cdp.evaluate('location.href');
    if (ctx.isDesktop) includes(url, 'tauri.localhost', 'the page is served by the Tauri asset host');
    else includes(url, `127.0.0.1:${opts.webPort}`, 'the page is served on this run’s loopback port');
    return `${title} @ ${url}`;
  }, { fatal: true });

  await step('the shipped binary reports where its data lives', 'device', async () => {
    const info = await cdp.evaluate(`(function(){
      const i = window.__TAURI_INTERNALS__;
      if (!i || !i.invoke) return JSON.stringify({error: 'no __TAURI_INTERNALS__ invoke bridge'});
      return i.invoke('app_paths').then((p) => JSON.stringify(p)).catch((e) => JSON.stringify({error: String(e)}));
    })()`);
    const paths = JSON.parse(String(info));
    ok(!paths.error, 'app_paths answered', paths.error);
    ctx.paths = { appData: paths.appData, backups: paths.backups, contentRoot: paths.contentRoot };
    const fresh = ctx.guard.observeReported(paths.appData);
    const envHonoured = fresh.freshEnvHonoured;
    ok(
      envHonoured || ctx.guard.parkedTo !== null || !existsSync(ctx.guard.canonical),
      'the app writes into a directory this run owns or newly emptied (otherwise the profile was not fresh)',
      paths.appData,
    );
    ok(typeof paths.contentRoot === 'string' && paths.contentRoot.length > 0, 'a content root is resolved at all');
    ok(!process.env.QURAN_CONTENT_DIR, 'the content root did not come from a QURAN_CONTENT_DIR override', process.env.QURAN_CONTENT_DIR ?? '(unset)');
    return `appData=${paths.appData} · content=${paths.contentRoot} · APPDATA redirect honoured=${envHonoured ? 'yes' : 'no (parked profile instead)'}`;
  }, { fatal: true, skip: !ctx.isDesktop, skipReason: 'the web shell has no native path resolver; its storage is the browser profile this run created' });

  const autoImport = !ctx.isDesktop;

  await step('first run shows the empty state with its import button', 'device', async () => {
    await cdp.go('/');
    // HomeScreen: «هنوز محتوایی وارد نشده است» + «وارد کردن بسته‌های محتوا».
    await cdp.waitFor(hasButton('وارد کردن بسته‌های محتوا|Import content packs'), { timeoutMs: 30_000, label: 'first-run import affordance' });
    return 'empty state on / offers one-click import';
  }, {
    fatal: true,
    skip: autoImport,
    skipReason: 'the web build imports the packs it is served on startup; a first-run button asking for it would itself be the defect',
  });

  /* ---------------------------------------------------------------- import */

  const importWall = await step(
    autoImport ? 'the web build imports the bundled packs on startup, unasked' : 'one click imports the bundled packs',
    'device',
    async () => {
      const t0 = Date.now();
      // Both shells must pass an empty store before the report can appear: a fresh
      // browser profile and a fresh %APPDATA% both start with nothing.
      await cdp.go('/');
      const label = autoImport ? null : await cdp.clickText('وارد کردن بسته‌های محتوا|Import content packs');
      // The finish line is the report the app stores when its write commits. The
      // empty state disappearing is not a finish line: the button also goes away
      // while the import is still running, which reported a 2 s "import" for an
      // import that takes ten times that.
      let report = null;
      while (Date.now() - t0 < 600_000) {
        report = await store.importReport().catch(() => null);
        if (report) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      ok(report, 'the app stored its ImportReport for this import', { waitedMs: Date.now() - t0 });
      is(report.status, 'success', `the stored report says the import succeeded (${JSON.stringify(report.issue ?? null)})`);
      if (!autoImport) {
        await cdp.waitFor(`!${hasButton('وارد کردن بسته‌های محتوا|Import content packs')}`, { timeoutMs: 120_000, intervalMs: 1000, label: 'the empty state to give way to content' });
      }
      const ms = Date.now() - t0;
      return autoImport
        ? `no click: the gateway read ${report.packs.length} packs from its own origin and stored the report after ${ms} ms (device-level wall clock, 1 s polling)`
        : `clicked “${label}”; the app's own report landed after ${ms} ms (device-level wall clock, 1 s polling)`;
    },
    { fatal: true },
  );
  ctx.importWallMs = importWall === undefined ? null : Number(String(importWall).match(/\d+/)?.[0] ?? NaN);

  await step('the import report the app stored says every pack applied', 'database', async () => {
    const report = await store.importReport();
    ok(report, 'an ImportReport was stored', null);
    is(report.status, 'success', 'report.status');
    is(report.packs.length, expected.packRows, 'number of packs in the report');
    ok(report.durationMs > 0, 'durationMs is a positive measured number', report.durationMs);
    for (const pack of report.packs) {
      ok(pack.checksumOk, `pack ${pack.packId} checksum re-verified over its payload`, pack.checksumOk);
      is(pack.recordsApplied, expected.perPackRecords[pack.packId], `pack ${pack.packId} records applied == manifest recordCount`);
      is(pack.checksum, expected.checksums[pack.packId], `pack ${pack.packId} digest matches content/index.json`);
    }
    return `${report.packs.length} packs, ${Math.round(report.durationMs)} ms by the app's own clock (defect 11's fixed measure)`;
  }, { fatal: true, skip: !store.supports('importReport'), skipReason: store.unsupportedReason });

  await step('the imported rows are in the store the app wrote', 'database', async () => {
    const counts = await store.contentCounts();
    const want = {
      surahs: expected.surahs,
      ayahs: expected.ayahs,
      words: expected.words,
      translations: expected.translations,
      tafsirs: expected.tafsirs,
      similar: expected.similar,
      packs: expected.packRows,
    };
    eq(counts, want, 'content row counts equal the pack manifests');
    return `surahs ${counts.surahs} · ayahs ${counts.ayahs} · words ${counts.words} · translations ${counts.translations} · tafsirs ${counts.tafsirs} · similar ${counts.similar} · packs ${counts.packs}`;
  }, { fatal: true, skip: !store.supports('contentCounts'), skipReason: store.unsupportedReason });

  await step('the data-health screen prints those same numbers', 'device', async () => {
    await cdp.go('/me/content');
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 60_000, label: 'data health to finish reading' });
    const body = await cdp.bodyText(12_000);
    // ContentHealthScreen COUNT_LABELS: سوره / آیه / واژه / ترجمه / تفسیر / آیهٔ مشابه / بسته
    const pairs = [
      ['سوره', expected.surahs],
      ['آیهٔ مشابه', expected.similar],
      ['بسته', expected.packRows],
    ];
    for (const [label, value] of pairs) {
      // The unique labels are checked as text; the shared «آیه» prefix is not.
      includes(body, `${label}`, `data-health names ${label}`);
      includes(body, faNumber(value), `data-health shows ${label} = ${value} in Persian digits`);
    }
    const words = await cdp.evaluate(`(function(){
      // ContentHealthScreen renders each count as <div class="counts__item"><dt>label</dt><dd>value</dd>.
      // Read the pair from the DOM rather than from innerText: an RTL definition list
      // does not guarantee the label and its number land adjacent in innerText order.
      const item = Array.from(document.querySelectorAll('.counts__item')).find(
        (el) => (el.querySelector('dt')?.textContent || '').trim() === 'واژه',
      );
      // Directional marks around a number in an RTL line are presentation, not
      // data: they are stripped before comparing digits.
      const strip = (s) => s.replace(/[\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]/g, '').trim();
      return item ? strip(item.querySelector('dd')?.textContent || '') : null;
    })()`);
    is(words, faNumber(expected.words), 'word count printed on screen equals the manifest total');
    return `screen shows ${faNumber(expected.surahs)} سوره / ${faNumber(expected.similar)} آیهٔ مشابه / ${words} واژه`;
  }, { fatal: false });

  /* ------------------------------------------------------- quran: surah/ayah */

  await step('the surah index lists every chapter', 'device', async () => {
    await cdp.go('/quran');
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'surah index' });
    const links = await cdp.count('a.linkbtn[href^="#/quran/surah/"]');
    is(links, expected.surahs, 'one reader link per surah');
    return `${links} surah links`;
  });

  // Ar-Rahman 55:13 is the refrain the hifz fixtures already use; surah 112 is
  // short enough to render fully, so the reader step is cheap and exact.
  const SURAH = 112;
  const keys = await store.surahAyahKeys(SURAH);
  await step(`opening surah ${SURAH} renders exactly its stored ayat`, 'device', async () => {
    await cdp.go(`/quran/surah/${SURAH}`);
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'surah reader' });
    const rows = await cdp.count('article.ayah');
    is(rows, keys.length, `article.ayah rows equal the ayah rows stored for surah ${SURAH}`);
    const first = await cdp.evaluate(`(function(){const a=document.querySelector('article.ayah');return a?a.getAttribute('data-verse-key'):null;})()`);
    is(first, keys[0], 'the first rendered row carries the first stored verse key');
    ctx.readerKeys = keys;
    return `${rows} ayah rows, first ${first}`;
  }, { skip: !store.supports('surahAyahKeys'), skipReason: store.unsupportedReason });

  await step('choosing a translation pack puts its stored text on screen', 'device', async () => {
    const packId = expected.translationPackIds.find((id) => id.startsWith('tr-fa')) ?? expected.translationPackIds[0];
    const clicked = await cdp.evaluate(`(function(){
      const want = ${JSON.stringify(packId)};
      const input = Array.from(document.querySelectorAll('input[name="translation-pack"]')).find((i) => i.getAttribute('data-pack-id') === want);
      if (!input) return 'no-radio';
      (input.closest('label') || input).click();
      return 'ok';
    })()`);
    is(clicked, 'ok', `the radio for translation pack ${packId} exists in the reader toolbar`);
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 30_000, label: 'the reader to re-render' });
    // Ask the DOM which pack is actually selected, rather than assuming the click
    // landed on the one this step meant to choose: two Persian packs render almost
    // the same sentence, and only the pack id tells them apart.
    const checked = await cdp.evaluate(`(function(){
      const el = Array.from(document.querySelectorAll('input[name="translation-pack"]')).find((i) => i.checked);
      return el ? (el.getAttribute('data-pack-id') || 'no-pack-id') : 'none-checked';
    })()`);
    is(checked, packId, 'the toolbar has that pack selected after the click');
    const key = keys[0];
    const rows = await store.translationsFor(key);
    const stored = rows.find((r) => r.pack_id === packId);
    ok(stored, `the store has a ${packId} row for ${key}`, rows.map((r) => r.pack_id));
    // The reader refills its translation text after the pack change lands, one
    // request per row, so a single instantaneous read can still show the previous
    // pack. Poll the stored bytes with a deadline; report whatever is on screen
    // when it expires.
    const readShown = () =>
      cdp.evaluate(`(function(){
        const a = document.querySelector('article.ayah[data-verse-key="${key}"]');
        const p = a && a.querySelector('.ayah__trtext');
        return p ? p.textContent.trim() : null;
      })()`);
    const want = flatten(stored.text);
    let shown = null;
    const deadline = Date.now() + 20_000;
    for (;;) {
      shown = await readShown();
      if (flatten(shown) === want) break;
      if (Date.now() >= deadline) break;
      await sleep(250);
    }
    is(flatten(shown), want, `the rendered translation is the stored ${packId} bytes for ${key}`, {
      checkedPack: checked,
      otherPacksOnRow: rows.map((r) => `${r.pack_id}: ${flatten(r.text).slice(0, 40)}`),
    });
    return `${packId} shown for ${key}: ${flatten(shown).slice(0, 60)}…`;
  }, { skip: !store.supports('translationsFor'), skipReason: store.unsupportedReason });

  const focusKey = keys[0];
  await step('the single-ayah screen shows the word rows as imported', 'device', async () => {
    await cdp.go(`/quran/ayah/${encodeURIComponent(focusKey)}`);
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'single ayah' });
    const rendered = await cdp.evaluate(`(function(){
      const words = Array.from(document.querySelectorAll('.quran-text .word')).map((w) => w.textContent.trim());
      return JSON.stringify(words);
    })()`);
    const shown = JSON.parse(String(rendered));
    const stored = (await store.wordsFor(focusKey)).filter((w) => !Number(w.is_end_of_ayah_mark)).map((w) => String(w.text_uthmani));
    eq(shown, stored, 'every rendered word span equals the stored ayah_word row, in position order');
    return `${shown.length} word spans, byte-identical to the store`;
  }, { skip: !store.supports('wordsFor'), skipReason: store.unsupportedReason });

  const tafsirKey = await store.verseKeyWithTafsir('tafsir-ar-muyassar');
  await step('tafsir for an ayah comes from the pack that carries it', 'device', async () => {
    await cdp.go(`/quran/ayah/${encodeURIComponent(tafsirKey)}`);
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'single ayah with tafsir' });
    // AyahFocusScreen Panel «تفسیر» → TafsirPanel `.tafr__item` per stored row.
    const items = await cdp.count('.tafr__item');
    const rows = await store.tafsirFor(tafsirKey);
    is(items, rows.length, `tafsir passages rendered equal the stored tafsir rows for ${tafsirKey}`);
    const title = await cdp.textOf('.tafr__title');
    const packId = String(rows[0].pack_id);
    is(title, rows[0].title, 'the passage is attributed with its pack title, not a generic heading');
    const body = await cdp.textOf('.tafr__text');
    const stripped = String(rows[0].text).replace(/<[^>]*>/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([،؛:.!?])/g, '$1').trim();
    is(String(body).replace(/\s+/g, ' ').trim(), stripped.replace(/\s+/g, ' ').trim(), 'the passage text is the stored text with only provider markup dropped');
    return `${tafsirKey}: ${items} passage(s) from ${packId} — “${title}”`;
  }, { skip: !store.supports('tafsirFor') || !tafsirKey, skipReason: store.unsupportedReason });

  const similarInfo = await store.busiestSimilarKey();
  await step('the similar-ayah panel lists stored pairs', 'device', async () => {
    const key = similarInfo.verseKey;
    await cdp.go(`/quran/ayah/${encodeURIComponent(key)}`);
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'single ayah' });
    // AyahFocusScreen asks the gateway for at most 10 partners.
    await cdp.waitFor(`(function(){return document.querySelectorAll('.similalist li').length > 0 || ${LOADING};})()`, { timeoutMs: 30_000, label: 'the similar-ayah list' });
    const listed = await cdp.evaluate(`(function(){
      return JSON.stringify(Array.from(document.querySelectorAll('.similalist li a.linkbtn')).map((a)=>a.textContent.trim()));
    })()`);
    const partners = JSON.parse(String(listed));
    const stored = (await store.similarPairs(key)).slice(0, 10).map((p) => p.partner);
    eq(new Set(partners), new Set(stored), `the panel lists exactly the stored partners of ${key} (capped at 10 as the gateway does)`);
    ctx.similarKey = key;
    return `${key}: ${partners.length} similar ayat listed, all present in similar_ayah`;
  }, { skip: !store.supports('similarPairs') || !similarInfo, skipReason: store.unsupportedReason });

  await step('the mutashabihat browser opens for that ayah', 'device', async () => {
    await cdp.go(`/discover/mutashabihat?vk=${encodeURIComponent(ctx.similarKey)}`);
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'mutashabihat screen' });
    const body = await cdp.bodyText(3000);
    ok(ctx.similarKey.split(':')[0] !== '' && body.includes(ctx.similarKey), 'the queried verse key is echoed on screen', body.slice(0, 160));
    return `screen answers for ${ctx.similarKey}`;
  });

  /* ------------------------------------------------ user marks: bookmark/note */

  await step('bookmarking the ayah stores one row with that verse key', 'device', async () => {
    await cdp.go(`/quran/ayah/${encodeURIComponent(focusKey)}`);
    await cdp.waitFor(hasButton('^نشانک$|^Bookmarked$'), { timeoutMs: 40_000, label: 'the bookmark toggle' });
    const before = (await store.userCounts()).bookmarks;
    // AyahFocusScreen: «نشانک» → «نشانک‌شده» once stored.
    const label = await cdp.clickText('^نشانک$|^Bookmarked$');
    await cdp.waitFor(hasButton('نشانک‌شده|Bookmarked'), { timeoutMs: 20_000, label: 'the button to read “Bookmarked”' });
    const after = await store.userCounts();
    is(after.bookmarks, before + 1, 'exactly one bookmark row was added');
    const row = await store.bookmarkRow(focusKey);
    ok(row, `a bookmark row exists for ${focusKey}`, null);
    ctx.bookmarkKey = focusKey;
    return `clicked “${label}” → bookmark row for ${focusKey}`;
  }, { fatal: false, skip: !store.supports('bookmarkRow'), skipReason: store.unsupportedReason });

  const NOTE_BODY = `یادداشت آزمون e2e — ${new Date().toISOString()}`;
  await step('a note typed in the reader is stored byte-for-byte', 'device', async () => {
    await cdp.go(`/quran/surah/${SURAH}`);
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'surah reader' });
    // AyahFeed fills rows in batches, so the row itself — not just the absence of
    // a spinner — is the condition the click may wait on.
    await cdp.waitFor(`!!document.querySelector('article.ayah[data-verse-key="${keys[1]}"]')`, { timeoutMs: 40_000, label: `the row for ${keys[1]}` });
    // AyahRow tools: «یادداشت» opens NotePanel, «ذخیرهٔ یادداشت» saves it. The
    // selector already names the row by its data-verse-key; matching on
    // textContent would need the whole ayah, the translation and the reference.
    await cdp.clickInRow(`article.ayah[data-verse-key="${keys[1]}"]`, null, 'یادداشت|Notes');
    await cdp.waitFor(`!!document.querySelector('article.ayah[data-verse-key="${keys[1]}"] textarea')`, { timeoutMs: 20_000, label: 'the note textarea' });
    await cdp.evaluate(`(function(){
      const el = document.querySelector('article.ayah[data-verse-key="${keys[1]}"] textarea');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(NOTE_BODY)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    const row = `article.ayah[data-verse-key="${keys[1]}"]`;
    await cdp.evaluate(`(function(){
      const root = document.querySelector(${JSON.stringify(row)});
      const b = Array.from(root.querySelectorAll('button')).find((x)=>/ذخیرهٔ یادداشت|Save note/.test(x.textContent.trim()));
      if (!b) return 'no-save';
      b.click();
      return 'clicked';
    })()`);
    await cdp.waitFor(`(function(){const root=document.querySelector(${JSON.stringify(row)});return root && root.textContent.includes(${JSON.stringify(NOTE_BODY)});})()`, { timeoutMs: 25_000, label: 'the note to appear under the ayah' });
    const stored = await store.noteRow(keys[1]);
    ok(stored, `a note row exists for ${keys[1]}`, null);
    is(String(stored.body), NOTE_BODY, 'the stored note body is exactly what was typed');
    ctx.noteKey = keys[1];
    return `note stored for ${keys[1]} (${NOTE_BODY.length} chars, identical bytes)`;
  }, { skip: !store.supports('noteRow'), skipReason: store.unsupportedReason });

  /* ------------------------------------------------------------------ hifz */

  await step('adding the ayah to the hifz set stores an engine-created item', 'device', async () => {
    await cdp.go(`/quran/ayah/${encodeURIComponent(focusKey)}`);
    await cdp.waitFor(hasButton('افزودن به حفظ|Add to hifz|خروج از حفظ|Remove from hifz'), { timeoutMs: 40_000, label: 'the hifz toggle' });
    await cdp.clickText('افزودن به حفظ|Add to hifz');
    await cdp.waitFor(hasButton('خروج از حفظ|Remove from hifz'), { timeoutMs: 25_000, label: 'the button to read “Remove from hifz”' });
    const item = await store.hifzItem(focusKey);
    ok(item, `hifz_item row for ${focusKey}`, null);
    is(String(item.band), 'new', 'a freshly added item starts in the engine’s “new” band');
    is(Number(item.attempt_count), 0, 'a freshly added item has no attempts yet');
    return `${focusKey} stored as band=${item.band}, segments derived by the engine`;
  }, { skip: !store.supports('hifzItem'), skipReason: store.unsupportedReason });

  await step('the items screen adds a whole surah range', 'device', async () => {
    await cdp.go('/hifz/items');
    await cdp.waitFor(`(function(){return !!document.querySelector('input[aria-label="شمارهٔ سوره"], input[aria-label="Surah number"]');})()`, { timeoutMs: 40_000, label: 'the range inputs' });
    await cdp.type('input[aria-label="شمارهٔ سوره"], input[aria-label="Surah number"]', String(SURAH));
    await cdp.type('input[aria-label="از آیه"], input[aria-label="From ayah"]', '1');
    await cdp.type('input[aria-label="تا آیه"], input[aria-label="To ayah"]', String(keys.length));
    await cdp.clickText('افزودن بازه|Add range');
    await cdp.waitFor(`(function(){return document.body.innerText.replace(/\\s+/g,' ').includes(${JSON.stringify(String(keys.length))}) && !document.querySelector('.state--loading');})()`, { timeoutMs: 40_000, label: 'the range to be applied' });
    const itemRows = await cdp.evaluate(`(function(){return JSON.stringify(Array.from(document.querySelectorAll('.item-row a.linkbtn')).map((a)=>a.textContent.trim()).filter((t)=>/^\\d+:\\d+$/.test(t)));})()`);
    const listed = JSON.parse(String(itemRows));
    const stored = (await store.hifzItems()).map((r) => String(r.verse_key));
    eq(new Set(listed), new Set(stored), 'the items screen lists exactly the stored hifz items');
    is(stored.length, keys.length, `${keys.length} ayahs of surah ${SURAH} are now in the set`);
    ctx.hifzKeys = stored;
    return `${stored.length} items: ${stored.join(', ')}`;
  }, { skip: !store.supports('hifzItems'), skipReason: store.unsupportedReason });

  /**
   * Does what the engine grades actually cover the revelation? Two witnesses, in
   * order of honesty: the stored `hifz_segment` rows if the app writes any, and the
   * `expected_word_count` of every attempt it graded. A session that claims to have
   * scored words an offline learner never had to recall is a fake number, so the
   * counts are compared against the ayah_word rows the import landed.
   */
  await step('the plan covers the stored words of every enrolled ayah', 'database', async () => {
    const items = await store.hifzItems();
    const segments = await store.segments();
    ok(items.length > 0, 'the journey enrolled at least one ayah', items.length);
    const empty = segments.filter((row) => !(Number(row.to_word) >= Number(row.from_word) && Number(row.from_word) >= 1 && Number(row.text_length) > 0));
    is(empty.length, 0, 'no stored segment is wordless, out of range or has empty text', empty.slice(0, 5));
    // Both gateways enrol the engine’s tiling beside the item (`gateway/segmentation.ts`),
    // so on a fresh database an enrolled ayah with no chunks is a defect, not a
    // limitation. The claim used to live here as a NOTE describing a version of the
    // app that wrote segments only during a restore; that version is gone.
    ok(segments.length > 0, 'enrolling an ayah stored its engine-derived segments', {
      segments: segments.length,
      items: items.length,
      first: segments[0] ?? null,
    });
    for (const row of segments) {
      const words = (await store.wordsFor(String(row.verse_key))).filter((w) => !Number(w.is_end_of_ayah_mark)).length;
      ok(Number(row.to_word) <= words, `${row.verse_key} segment ${row.position} cannot reach word ${row.to_word} of ${words}`, null);
    }
    return `${segments.length} segment row(s) stored over ${items.length} enrolled item(s)`;
  }, { skip: !store.supports('segments'), skipReason: store.unsupportedReason });

  await step("today's mission offers a session for the new items", 'device', async () => {
    await cdp.go('/hifz');
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'today screen' });
    await cdp.waitFor(hasButton('شروع نشست|Start session'), { timeoutMs: 40_000, label: 'the session CTA' });
    return 'mission screen ready; the engine builds the steps';
  });

  /**
   * Key order inside a stored JSON column is not a promise the app makes: the
   * envelope round-trips objects through `JSON.parse`/`JSON.stringify`, which
   * re-orders fields alphabetically. Comparing the bytes would fail a restore
   * that is semantically perfect, so compare parsed structures canonically and
   * report the byte difference instead of asserting it away.
   */
  const canonical = (value) => {
    try {
      return canonicalJsonStringify(JSON.parse(String(value)));
    } catch {
      return String(value);
    }
  };

  const wrongTextFor = async (verseKey) => {
    // Another ayah's words: the classifier must see substitutions, and the
    // harness knows exactly what it submitted, so the stored row can be compared.
    // The source must not be the step's own ayah — submitting 112:4 to a step
    // that cues 112:4 is a flawless recitation, and the run that did that
    // reported "0 classified errors" as if the engine had missed the mistake.
    const rows = await store.wordsFor(verseKey);
    const tokens = rows.filter((r) => !Number(r.is_end_of_ayah_mark)).map((r) => String(r.text_uthmani));
    const wanted = String(verseKey);
    const donor = keys.find((key) => key !== wanted) ?? '112:4';
    let other = (await store.wordsFor(donor)).filter((r) => !Number(r.is_end_of_ayah_mark)).map((r) => String(r.text_uthmani));
    if (other.length === 0 || other.join(' ') === tokens.join(' ')) other = tokens.slice().reverse();
    return other.join(' ');
  };

  /**
   * What the runner offers on the current step. SessionRunnerScreen renders no
   * recitation panel for a step without a probe, and a disabled textarea plus a
   * disabled submit for one it cannot score — both mean "skip", not "finished",
   * because «پایان نشست و گزارش» is on screen from step one to the last.
   *
   * The expected-word chip is read with it because a step the runner calls ready
   * while the engine expects zero words is a dead step: nothing the learner types
   * could be scored. The chip is the engine's own number, shown in Persian digits.
   */
  const readStep = async ({ timeoutMs = 60_000 } = {}) => {
    const from = Date.now();
    for (;;) {
      const raw = await cdp.evaluate(`(function(){
        const toAscii = (s) => String(s).replace(/[\\u06F0-\\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0)).replace(/\\D/g, '');
        const chip = Array.from(document.querySelectorAll('.chip')).find((el) => /واژه‌های انتظار|expected words/.test(el.textContent || ''));
        const num = chip ? chip.querySelector('.num') : null;
        const t = document.querySelector('textarea');
        const submit = Array.from(document.querySelectorAll('button')).find((b)=>/ثبت و نمره|Submit for engine/.test((b.textContent||'').trim()));
        const err = document.querySelector('.state--error');
        return JSON.stringify({
          loading: !!document.querySelector('.state--loading'),
          error: err ? (err.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null,
          empty: !!document.querySelector('.state--empty'),
          hasTextarea: !!t,
          textareaDisabled: !!t && !!t.disabled,
          hasSubmit: !!submit,
          submitDisabled: !!submit && !!submit.disabled,
          expected: num ? Number(toAscii(num.textContent)) : null,
          // The runner stops offering Next step on the plan’s last verdict and
          // says so in a chip. Without reading it, a finished plan looks exactly
          // like a stuck screen.
          lastStep: /به پایان گام‌ها|all steps reached/i.test(document.body.innerText),
        });
      })()`);
      const s = JSON.parse(String(raw));
      const classify = (extra) => {
        const state = s.hasTextarea
          ? (s.textareaDisabled || !s.hasSubmit || s.submitDisabled ? 'disabled' : 'ready')
          : 'none';
        return { ...s, state, ...extra };
      };
      if (s.error) return classify({ state: 'error', waitedMs: Date.now() - from });
      if (!s.loading && (s.hasTextarea || s.empty)) return classify({ waitedMs: Date.now() - from });
      if (Date.now() - from >= timeoutMs) {
        // A textarea that arrived while we were timing out is still an answer;
        // only a step that never produced anything at all is a failure.
        if (s.hasTextarea) return classify({ waitedMs: Date.now() - from, timedOut: true });
        return { ...s, state: 'unsettled', timedOut: true, waitedMs: Date.now() - from };
      }
      await sleep(200);
    }
  };

  /** The plan size the runner prints in its own panel title: «گام N / M». */
  const stepCount = () =>
    cdp.evaluate(`(function(){
      const toAscii = (s) => String(s).replace(/[\\u06F0-\\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0)).replace(/\\D/g, '');
      const title = Array.from(document.querySelectorAll('.panel__title')).find((el) => /گام|Step/.test(el.textContent || ''));
      if (!title) return null;
      const nums = Array.from(title.querySelectorAll('.num')).map((el) => Number(toAscii(el.textContent)));
      return nums.length >= 2 ? { at: nums[0], of: nums[1] } : null;
    })()`);

  /**
   * Walk a session to its end. `firstWrong` seeds one deliberately mistaken
   * recitation on the first recordable step and answers the rest correctly;
   * `wrongOnly` repeats the mistake, which is what the drill session does.
   */
  const driveSession = async ({ maxSteps = 16, firstWrong = false, wrongOnly = false } = {}) => {
    const answered = [];
    const dead = [];
    let wrongSubmission = null;
    let skipped = 0;
    /** How the walk stopped: the plan’s own last step, or the harness’s guard. */
    let ended = 'guard';
    for (let guard = 0; guard < maxSteps; guard += 1) {
      const s = await readStep();
      ok(s.state !== 'error', 'the runner built the step probe instead of failing', { step: guard + 1, error: s.error, waitedMs: s.waitedMs });
      // The runner never offers another step after the plan’s last verdict; it
      // shows the «all steps reached» chip instead. Ending here is the session
      // finishing, and the harness must not read that as a screen that failed to
      // settle — which is exactly what the 60-second stall used to be.
      if (s.lastStep) {
        ended = 'last-step';
        break;
      }
      ok(s.state !== 'unsettled', 'the step settled into something the harness can act on', {
        step: guard + 1,
        ...s,
        // A step with no recitation box and no `.state--*` panel is not a guess:
        // the panel titles and the control inventory say which of the runner's
        // faces actually rendered (verdict, drill notice, or nothing).
        panels: await cdp.evaluate(`(function(){return JSON.stringify(Array.from(document.querySelectorAll('.panel__title')).map((el)=>(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,48)));})()`),
        controls: await cdp.evaluate(`(function(){return JSON.stringify(Array.from(document.querySelectorAll('button, a.linkbtn, [role=button]')).map((el)=>(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,28)).filter(Boolean).slice(0,14));})()`),
        body: await cdp.bodyText(600),
      });
      if (s.state !== 'ready') {
        const canSkip = await cdp.evaluate(hasButton('رد شدن|Skip'));
        const canNext = await cdp.evaluate(hasButton('گام بعدی|Next step'));
        if (!canSkip && !canNext) {
          ended = 'no-affordance';
          break;
        }
        skipped += 1;
        dead.push({ step: guard + 1, state: s.state, expected: s.expected, waitedMs: s.waitedMs });
        await cdp.clickText(canSkip ? 'رد شدن|Skip' : 'گام بعدی|Next step');
        await cdp.waitFor(`!${LOADING}`, { timeoutMs: 30_000, label: 'the next step' });
        continue;
      }
      if (s.expected === 0) {
        dead.push({ step: guard + 1, state: s.state, expected: s.expected, waitedMs: s.waitedMs });
        ok(false, 'a step the runner lets the learner answer never expects zero words', { step: guard + 1, body: await cdp.bodyText(400) });
      }
      const verseKey = await cdp.evaluate(`(function(){
        const m = document.body.innerText.match(/(\\d{1,3}:\\d{1,4})/);
        return m ? m[1] : null;
      })()`);
      const wantWrong = wrongOnly ? true : firstWrong ? wrongSubmission === null : false;
      const text = wantWrong
        ? await wrongTextFor(verseKey ?? focusKey)
        : String((await store.wordsFor(verseKey ?? focusKey)).filter((r) => !Number(r.is_end_of_ayah_mark)).map((r) => String(r.text_uthmani)).join(' '));
      await cdp.evaluate(`(function(){
        const el = document.querySelector('textarea');
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        set.call(el, ${JSON.stringify(text)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()`);
      await cdp.clickText('ثبت و نمره توسط موتور|Submit for engine scoring');
      /**
       * The engine's verdict panel replaces the input once the attempt is stored.
       * It is matched by its own panel title, and only counted as arrived when the
       * recitation box is gone: the header chip «ثبت‌شده: N» is on screen from step
       * one, so the body-text pattern this wait used to carry returned the moment
       * the click landed, the harness then asked for a Next-step control that had
       * not rendered yet, and the journey stalled on a perfectly good verdict.
       */
      await cdp.waitFor(`(function(){
        const titled = Array.from(document.querySelectorAll('.panel__title')).some((el) => /داوری موتور|Engine verdict/.test(el.textContent || ''));
        return titled && !document.querySelector('textarea');
      })()`, { timeoutMs: 45_000, label: 'the engine verdict panel' });
      const tokens = text.split(/\s+/).filter(Boolean).length;
      answered.push({ verseKey, wrong: wantWrong, tokens, expected: s.expected });
      if (wantWrong && firstWrong) wrongSubmission = { verseKey: verseKey ?? focusKey, tokens };
      // The last step's verdict has no Next-step button, only the «all steps
      // reached» chip, so the wait accepts either affordance before the click is
      // attempted — otherwise a finished plan reads as a stuck harness.
      await cdp.waitFor(`(function(){
        const has = Array.from(document.querySelectorAll('button, a.linkbtn, [role=button]')).some((el) => /گام بعدی|Next step/.test((el.textContent || '').trim()));
        return has || /به پایان گام‌ها|all steps reached/i.test(document.body.innerText);
      })()`, { timeoutMs: 30_000, label: 'the verdict’s next-step affordance' });
      if (await cdp.evaluate(hasButton('گام بعدی|Next step'))) await cdp.clickText('گام بعدی|Next step');
      await cdp.waitFor(`!${LOADING}`, { timeoutMs: 45_000, label: 'the next step to settle' });
    }
    return { answered, wrongSubmission, skipped, dead, ended };
  };

  const sessionSummary = await step('a recall session runs, scores through the engine and stores its attempts', 'device', async () => {
    await cdp.clickText('شروع نشست|Start session');
    await cdp.waitFor(`location.hash.startsWith('#/hifz/session')`, { timeoutMs: 30_000, label: 'the session launcher' });
    // SessionRunnerScreen: the launcher's own start button, same label.
    await cdp.waitFor(hasButton('شروع نشست|Start session'), { timeoutMs: 40_000, label: 'the launcher start' });
    await cdp.clickText('شروع نشست|Start session');
    await cdp.waitFor(`(function(){return /گام|Step/.test(document.body.innerText) && !document.querySelector('.state--loading');})()`, { timeoutMs: 60_000, label: 'the first step' });
    const plan = await stepCount();

    const { answered, wrongSubmission, skipped, dead, ended } = await driveSession({ maxSteps: 16, firstWrong: true });
    ok(answered.length > 0, 'a session built from today’s plan offers at least one recordable recitation step', { plan, skipped, dead, seen: await cdp.bodyText(300) });
    ctx.sessionDeadSteps = dead;

    if (await cdp.evaluate(hasButton('پایان نشست و گزارش|Finish'))) {
      await cdp.clickText('پایان نشست و گزارش|Finish');
      await cdp.waitFor(`(function(){return location.hash.startsWith('#/hifz/session/');})()`, { timeoutMs: 60_000, label: 'the session report route' });
    }
    const readAt = Date.now();
    let rows = await store.attempts();
    while (rows.length < answered.length && Date.now() - readAt < 60_000) {
      // Each attempt is saved by the gateway on submit, but a second read-only
      // connection only sees committed rows once SQLite publishes them. Poll for
      // the rows rather than assuming the witness and the writer are in step.
      await new Promise((resolve) => setTimeout(resolve, 400));
      rows = await store.attempts();
    }
    ctx.attemptWitnessMs = Date.now() - readAt;
    ok(rows.length >= answered.length, 'every answered step produced a stored attempt row', { answered: answered.length, rows: rows.length, waitedMs: ctx.attemptWitnessMs });
    const errorCount = (a) => {
      try {
        return JSON.parse(a.errors).length;
      } catch {
        return -1;
      }
    };
    /**
     * Which row carries the deliberately wrong recitation. `produced` is stored as
     * the engine's own normalised tokens, so the harness matches the COUNT of words
     * it submitted, not their bytes — byte identity of the revelation itself is
     * pinned by the integrity suite, and a learner's recitation is not that text.
     * The fallback takes the row with the most classified errors for that verse,
     * and says so in the report rather than pretending the first match worked.
     */
    const forVerse = rows.filter((a) => String(a.verseKey) === String(wrongSubmission?.verseKey));
    const byCount = forVerse.find((a) => JSON.parse(a.produced).length === wrongSubmission?.tokens) ?? null;
    const wrong = byCount ?? forVerse.slice().sort((x, y) => errorCount(y) - errorCount(x))[0] ?? null;
    ctx.attemptRows = rows.length;
    ctx.wrongAttempt = wrong;
    ctx.wrongAttemptHow = byCount ? `matched ${wrongSubmission.verseKey} by its ${wrongSubmission.tokens} submitted words` : 'fallback: the row with the most classified errors for that verse';
    ctx.correctAttempt = rows.find((a) => errorCount(a) === 0 && a.id !== wrong?.id) ?? null;
    return `${answered.length} step(s) answered of ${plan?.of ?? '?'} (walk ended: ${ended}), ${rows.length} attempt rows stored · wrong row: ${wrong ? `${wrong.verseKey} (${errorCount(wrong)} errors, ${ctx.wrongAttemptHow})` : 'none found'}`;
  }, { skip: !store.supports('attempts'), skipReason: store.unsupportedReason });
  void sessionSummary;

  await step('the seeded error is stored as the engine classified it', 'database', async () => {
    ok(ctx.wrongAttempt, 'the deliberately wrong recitation produced a stored attempt', null);
    const errors = JSON.parse(ctx.wrongAttempt.errors);
    ok(Array.isArray(errors) && errors.length >= 1, 'a wrong recitation stores at least one classified error', ctx.wrongAttempt.errors);
    const kinds = new Set(errors.map((e) => e.kind));
    const allowed = new Set([
      'substitution',
      'omission',
      'insertion',
      'transposition',
      'word-order',
      'wrong-transition',
      'similar-ayah-confusion',
      'start-hesitation',
      'mid-hesitation',
      'stopped-short',
      'extra-words',
    ]);
    for (const kind of kinds) ok(allowed.has(kind), `error kind "${kind}" is one the engine's contract defines`, [...allowed]);
    ok(
      Number.isFinite(Number(ctx.wrongAttempt.accuracy)) && ctx.wrongAttempt.accuracy >= 0 && ctx.wrongAttempt.accuracy <= 1,
      'accuracy is a number in [0,1]',
      ctx.wrongAttempt.accuracy,
    );
    ok(ctx.wrongAttempt.accuracy < 1, 'the wrong recitation is not scored as perfect', ctx.wrongAttempt.accuracy);
    ok(
      ctx.wrongAttempt.correctWordCount < ctx.wrongAttempt.expectedWordCount,
      'fewer words were counted correct than expected',
      { correct: ctx.wrongAttempt.correctWordCount, expected: ctx.wrongAttempt.expectedWordCount },
    );
    const item = await store.hifzItem(ctx.wrongAttempt.verseKey);
    ok(item, 'the attempted ayah is still an item of the hifz set', ctx.wrongAttempt.verseKey);
    ok(Number(item.error_count) >= 1, `the item's stored error_count reflects the failure`, item.error_count);
    ctx.weakKey = String(ctx.wrongAttempt.verseKey);
    return `${ctx.wrongAttempt.verseKey}: accuracy ${ctx.wrongAttempt.accuracy}, kinds ${[...kinds].join(', ')}, item error_count ${item.error_count}`;
  }, { skip: !store.supports('attempts'), skipReason: store.unsupportedReason });

  await step('the weak screen and the review queue agree with the stored bands', 'device', async () => {
    await cdp.go('/hifz/weak');
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'weak screen' });
    // WeakScreen has two panels: «ضعیف‌های برنامهٔ امروز» (the engine's plan) and
    // «خطاهای تکراری در پنج تلاش آخر» (repeat offenders). They may name the same
    // ayah, which is why the keys are read per panel instead of as one flat list.
    const panels = JSON.parse(String(await cdp.evaluate(`(function(){
      return JSON.stringify(Array.from(document.querySelectorAll('.panel')).map((p) => ({
        title: (p.querySelector('.panel__title')?.textContent || '').trim(),
        keys: Array.from(p.querySelectorAll('.item-row a.linkbtn')).map((a) => a.textContent.trim()).filter((t) => /^\\d{1,3}:\\d{1,4}$/.test(t)),
      })));
    })()`)));
    const shown = new Set(panels.flatMap((p) => p.keys));
    const items = await store.hifzItems();
    const storedKeys = new Set(items.map((r) => String(r.verse_key)));
    for (const key of shown) ok(storedKeys.has(key), `the weak screen shows ${key}, which is a stored hifz item`, [...storedKeys]);

    // The repeat-offender panel is fully recomputable from the stored attempts, so
    // it is checked exactly, with the screen's own rule: across the item's last five
    // attempts, two or more classified errors whose kind is not `correct`.
    const attempts = await store.attempts();
    const repeat = new Set();
    for (const item of items) {
      const mine = attempts.filter((a) => String(a.itemId) === String(item.id)).slice(-5);
      let total = 0;
      for (const a of mine) {
        let parsed = [];
        try {
          parsed = JSON.parse(a.errors);
        } catch {
          parsed = [];
        }
        total += parsed.filter((e) => e && e.kind !== 'correct').length;
      }
      if (total >= 2) repeat.add(String(item.verse_key));
    }
    const offenderPanel = panels.find((p) => /خطاهای تکراری|Repeated errors/.test(p.title)) ?? null;
    ok(offenderPanel, 'the repeat-offender panel is on the screen', panels.map((p) => p.title));
    eq([...new Set(offenderPanel.keys)].sort(), [...repeat].sort(), 'the repeat-offender list is exactly what the stored attempts give');

    const weakStored = items.filter((r) => String(r.band) === 'weak').map((r) => String(r.verse_key));
    const body = await cdp.bodyText(2500);
    const emptyHonest = /نقطهٔ ضعفی ثبت نشده است|No weak spots recorded/.test(body);
    ok(!(shown.size === 0 && repeat.size === 0 && !emptyHonest), 'with nothing to show the screen states it in words', body.slice(0, 200));
    ctx.weakScreenNote = `${shown.size} distinct ayah(s) across ${panels.length} panels; ${weakStored.length} stored in the weak band; repeat offenders ${repeat.size}`;

    await cdp.go('/hifz/review');
    const queue = await settleOn('the review queue', '.state--empty, .panel', { timeoutMs: 60_000 });
    const queueEmpty = !!queue.empty;
    const queueCta = await cdp.evaluate(hasButton('ورود به نشست|Enter session'));
    if (queueEmpty) {
      // ReviewScreen's empty state has its own buttons and no session CTA. Saying
      // so is a pass; demanding a CTA the screen honestly does not offer is not.
      ok(!queueCta, 'an empty queue says so in words and offers no session entry point', queue.empty);
    } else {
      ok(queueCta, 'the review queue offers the session entry point', queue.body);
    }
    return `${ctx.weakScreenNote} · queue ${queueEmpty ? 'empty (stated in words)' : 'with entries'}, cta: ${queueCta}`;
  }, { skip: !store.supports('hifzItems'), skipReason: store.unsupportedReason });

  await step('a second session drills the weak spot and the queue re-prioritises', 'device', async () => {
    // The baseline is read here, before anything is clicked, and not carried in
    // from the previous step: measured after the walk it would already contain
    // the walk's own rows, and the assertion would compare 20 against 20.
    const before = (await store.attempts()).length;
    await cdp.go('/hifz/session');
    await cdp.waitFor(hasButton('شروع نشست|Start session'), { timeoutMs: 40_000, label: 'the session launcher' });
    await cdp.clickText('شروع نشست|Start session');
    await cdp.waitFor(`(function(){return /گام|Step/.test(document.body.innerText) && !document.querySelector('.state--loading');})()`, { timeoutMs: 60_000, label: 'a step' });
    const { answered: more, skipped, ended } = await driveSession({ maxSteps: 8, wrongOnly: true });
    if (await cdp.evaluate(hasButton('پایان نشست و گزارش|Finish'))) await cdp.clickText('پایان نشست و گزارش|Finish');
    const readAt = Date.now();
    let rows = await store.attempts();
    while (rows.length <= before && Date.now() - readAt < 60_000) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      rows = await store.attempts();
    }
    ok(rows.length > before, 'the second session stored more attempts than the first one', { before, after: rows.length, answered: more.length, skipped, ended });
    ctx.attemptRows = rows.length;
    return `${more.length} further step(s) answered (${skipped} skipped, ended: ${ended}); ${rows.length} attempt rows in total`;
  }, { skip: !store.supports('attempts'), skipReason: store.unsupportedReason });

  await step('every graded step covers words the ayah really has', 'database', async () => {
    const attempts = await store.attempts();
    ok(attempts.length > 0, 'the two sessions produced graded attempts', attempts.length);
    const wordsByVerse = new Map();
    for (const attempt of attempts) {
      const key = String(attempt.verseKey);
      if (!wordsByVerse.has(key)) {
        wordsByVerse.set(key, (await store.wordsFor(key)).filter((w) => !Number(w.is_end_of_ayah_mark)).length);
      }
      const words = wordsByVerse.get(key);
      const expected = Number(attempt.expectedWordCount);
      // A step whose expected-word count is zero cannot be answered correctly, and
      // one that expects more words than the revelation holds invents text. Both are
      // the same class of defect AGENTS.md forbids: numbers not derived from storage.
      ok(expected >= 1, `the engine graded ${key} against ${expected} expected word(s): a step must never expect zero`, {
        mode: attempt.mode,
        deadSteps: ctx.sessionDeadSteps ?? [],
      });
      ok(expected <= words, `${key}: the step expected ${expected} words but the stored ayah holds ${words}`, { mode: attempt.mode, words });
    }
    const full = attempts.filter((a) => Number(a.expectedWordCount) === wordsByVerse.get(String(a.verseKey)));
    ok(full.length > 0, 'at least one graded step covered a whole stored ayah', { attempts: attempts.length });
    const kinds = [...new Set(attempts.map((a) => a.mode))].sort();
    return `${attempts.length} graded step(s) over ${wordsByVerse.size} verse(s) · expected-word counts ${[...new Set(attempts.map((a) => a.expectedWordCount))].sort((x, y) => x - y).join('/')} · modes ${kinds.join(', ')}`;
  }, { skip: !store.supports('attempts'), skipReason: store.unsupportedReason });

  await step('confusion groups: the count on the screen is the stored count', 'device', async () => {
    await cdp.go('/hifz/confusion');
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'confusion screen' });
    let reported = null;
    if (await cdp.evaluate(hasButton('پیشنهاد دوبارهٔ موتور|Re-run engine proposals'))) {
      await cdp.clickText('پیشنهاد دوبارهٔ موتور|Re-run engine proposals');
      await cdp.waitFor(`!!document.querySelector('[role=status]')`, { timeoutMs: 40_000, label: "the engine's own answer" });
      reported = await cdp.textOf('[role=status]');
    }
    const cards = await cdp.count('.confirm, .panel');
    const stored = (await store.userCounts()).confusionGroups;
    const listedGroups = await cdp.evaluate(`(function(){
      return Array.from(document.querySelectorAll('.item-row, li')).filter((li)=>/اعضا|members:/.test(li.textContent||'')).length;
    })()`);
    ok(Number(listedGroups) === stored, `the screen renders one card per stored confusion group (found ${listedGroups}, stored ${stored}, panels counted ${cards})`, { listedGroups, stored });
    if (stored === 0) {
      suite.note('confusion group produced by practice', 'engine', `PROPOSE_MIN_TRIGGERS = 2 in core/src/hifz/params.ts: a group needs the SAME pair confused twice. This device run observed ${stored} group(s) after ${ctx.attemptRows} stored attempts; the engine reported: ${String(reported ?? '(no message)').slice(0, 120)}. The rule itself is proven at engine level in core/tests/hifz and at database level in tests/integration — not here.`);
      return `0 groups after ${ctx.attemptRows} attempts — reported honestly; screen and store agree`;
    }
    const group = await store.confusionGroupRow();
    ok(group, 'at least one confusion_group row exists', null);
    return `${stored} group(s) stored and rendered; engine said: ${String(reported ?? '').slice(0, 90)}`;
  }, { skip: !store.supports('confusionGroupRow'), skipReason: store.unsupportedReason });

  /* ----------------------------------------------------------------- backup */

  const stamp = opts.nameStamp;
  const backupName = `e2e-${stamp}.quranbak`;
  await step('a backup file is built and written by the app', 'device', async () => {
    await cdp.go('/me/backup');
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'backup screen' });
    await cdp.clickText('ساخت فایل از دادهٔ فعلی|Build from current data');
    await cdp.waitFor(hasButton('ذخیرهٔ فایل|Write file'), { timeoutMs: 40_000, label: 'the write control after building' });
    const named = await cdp.evaluate(`(function(){
      const el = document.querySelector('#backup-name, input[name="backup-name"]');
      if (!el) return 'no-name-field';
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(backupName)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    })()`);
    is(String(named), backupName, 'the file-name field holds the name this run asked for');
    const wroteAt = Date.now();
    await cdp.clickText('ذخیرهٔ فایل|Write file');
    const file = path.join(ctx.paths?.backups ?? '', backupName);
    // The artifact is the completion signal. Waiting for a body-text match was
    // wrong: «ذخیرهٔ فایل» is the button's own label, so such a wait passes before
    // the write has happened at all.
    let wroteInMs = null;
    if (ctx.isDesktop) {
      while (wroteInMs === null && Date.now() - wroteAt < 60_000) {
        if (existsSync(file)) wroteInMs = Date.now() - wroteAt;
        else await new Promise((resolve) => setTimeout(resolve, 250));
      }
      ok(wroteInMs !== null, `the app wrote ${file} on disk`, { waitedMs: Date.now() - wroteAt });
    }
    let raw = null;
    while (!raw && Date.now() - wroteAt < 60_000) {
      raw = await store.readBackup(backupName).catch(() => null);
      if (!raw) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    ok(typeof raw === 'string' && raw.length > 0, `the witness reads the backup ${backupName} back`, typeof raw);
    ok(!raw.endsWith('\n'), 'the file has no trailing newline (docs/backup-format.md)');
    const envelope = JSON.parse(raw);
    eq(canonicalJsonStringify(envelope), raw, 'the bytes on disk are canonical JSON of the parsed envelope');
    is(dataChecksum(envelope.data), envelope.checksum, 'the seal re-computes over the file data');
    const counts = await store.userCounts();
    is(Number(envelope.counts.bookmarks), counts.bookmarks, 'envelope counts.bookmarks equals the stored bookmark rows');
    is(Number(envelope.counts.notes), counts.notes, 'envelope counts.notes equals the stored note rows');
    const storedAttempts = await store.attempts();
    is(Number(envelope.counts.recallAttempts), storedAttempts.length, 'envelope counts.recallAttempts equals the stored attempt rows');
    ok(storedAttempts.length > 0, 'this journey produced recall attempts', storedAttempts.length);
    ctx.backupFile = ctx.isDesktop ? file : `localStorage:quran.backups/${backupName}`;
    ctx.backupRaw = raw;
    ctx.envelope = envelope;
    return `${ctx.backupFile} (${raw.length} chars) · counts ${JSON.stringify(envelope.counts)}`;
  }, { skip: !store.supports('userCounts'), skipReason: store.unsupportedReason });

  const snapshot = await step('snapshot the weak state exactly as it is now', 'database', async () => {
    const snap = await store.userSnapshot();
    ok(snap.hifz_attempt.length > 0, 'the snapshot contains the attempts this journey produced', snap.hifz_attempt.length);
    const target = snap.hifz_item.find((row) => String(row.verse_key) === ctx.weakKey) ?? snap.hifz_item[0];
    ok(target, 'the snapshot contains the hifz item the failure was recorded against', null);
    ctx.snapshot = snap;
    const itemOf = (key) => snap.hifz_item.find((r) => String(r.verse_key) === key);
    const attemptsOf = (id) => snap.hifz_attempt.filter((r) => String(r.item_id) === id);
    return `items ${snap.hifz_item.length} · attempts ${snap.hifz_attempt.length} · bookmarks ${snap.bookmark.length} · notes ${snap.note.length} · target ${target.verse_key} band=${target.band} stability=${target.stability} errors=${target.error_count} (item ${itemOf(String(target.verse_key)) ? 'found' : 'found by index'}) · attemptsOf ${attemptsOf(String(target.id)).length}`;
  }, { skip: !store.supports('userSnapshot'), skipReason: store.unsupportedReason });

  await step('the user rows are deleted through the UI, not by hand', 'device', async () => {
    const before = await store.userCounts();
    ok(before.bookmarks > 0 || before.notes > 0 || before.hifzItems > 0, 'there is something to delete', before);
    // Bookmark: toggle it off from the single-ayah screen.
    await cdp.go(`/quran/ayah/${encodeURIComponent(ctx.bookmarkKey ?? focusKey)}`);
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'single ayah' });
    if (await cdp.evaluate(hasButton('نشانک‌شده|Bookmarked'))) {
      await cdp.clickText('نشانک‌شده|Bookmarked');
      await cdp.waitFor(`(function(){return ${hasButton('^نشانک$|^Bookmark$')};})()`, { timeoutMs: 25_000, label: 'the bookmark to be removed' });
      const gone = await store.bookmarkRow(ctx.bookmarkKey ?? focusKey);
      ok(!gone, 'the bookmark row is really gone from storage', gone);
    }
    // Hifz items: ItemsScreen «حذف» → ConfirmBox arm → «حذف این مورد».
    await cdp.go('/hifz/items');
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'items screen' });
    let removed = 0;
    const itemTimings = [];
    for (let guard = 0; guard < 20; guard += 1) {
      const rowKeys = await cdp.evaluate(`(function(){
        const rows = Array.from(document.querySelectorAll('.item-row-wrap'));
        for (const row of rows) {
          const key = (row.textContent.match(/\\d{1,3}:\\d{1,4}/) || [''])[0];
          const btn = Array.from(row.querySelectorAll('button')).find((b)=>/^حذف$|^Remove$/.test(b.textContent.trim()));
          if (key && btn) { btn.click(); return key; }
        }
        return null;
      })()`);
      if (!rowKeys) break;
      const t0 = Date.now();
      await cdp.waitFor(`!!document.querySelector('.confirm__arm input[type=checkbox]')`, { timeoutMs: 20_000, label: 'the confirmation box' });
      await cdp.evaluate(`(function(){const cb=document.querySelector('.confirm__arm input[type=checkbox]');cb.click();return 'ok';})()`);
      await cdp.evaluate(`(function(){
        const b = Array.from(document.querySelectorAll('.confirm button')).find((x)=>/حذف این مورد|Remove this item/.test(x.textContent.trim()));
        if (!b) return 'no-confirm';
        if (b.disabled) return 'disabled';
        b.click();
        return 'confirmed';
      })()`);
      await cdp.waitFor(`(function(){return !document.querySelector('.confirm__arm') && !document.querySelector('.state--loading');})()`, { timeoutMs: 30_000, label: 'the item to leave the list' });
      itemTimings.push({ verseKey: rowKeys, ms: Date.now() - t0 });
      removed += 1;
    }
    // The note goes through the notes screen. NotesScreen reuses ConfirmBox: «حذف»
    // opens it, the checkbox arms it, «حذف کن» deletes. Clicking «حذف» and only
    // waiting for the box to close leaves the box open and the note in place — and
    // the loop then re-clicks the same button ten times, which is where the 153 s
    // this step used to take went.
    await cdp.go('/me/notes');
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'notes screen' });
    const deleteTimings = [];
    for (let guard = 0; guard < 10; guard += 1) {
      const opened = await cdp.evaluate(`(function(){
        const li = document.querySelector('li.note');
        if (!li) return 'no-row';
        const b = Array.from(li.querySelectorAll('button')).find((x)=>/^حذف$|^Delete$/.test((x.textContent||'').trim()));
        if (!b) return 'no-delete';
        b.click();
        return 'armed';
      })()`);
      if (opened !== 'armed') break;
      const t0 = Date.now();
      await cdp.waitFor(`!!document.querySelector('.confirm__arm input[type=checkbox]')`, { timeoutMs: 20_000, label: 'the note confirmation box' });
      await cdp.evaluate(`(function(){document.querySelector('.confirm__arm input[type=checkbox]').click();return 'ok';})()`);
      const confirmed = await cdp.evaluate(`(function(){
        const b = Array.from(document.querySelectorAll('.confirm button')).find((x)=>/حذف کن|Delete it/.test((x.textContent||'').trim()));
        if (!b) return 'no-confirm';
        if (b.disabled) return 'disabled';
        b.click();
        return 'confirmed';
      })()`);
      is(confirmed, 'confirmed', 'the note delete was confirmed through the shipped ConfirmBox');
      await cdp.waitFor(`(function(){return !document.querySelector('.confirm__arm') && !document.querySelector('.state--loading');})()`, { timeoutMs: 30_000, label: 'the note to leave the list' });
      deleteTimings.push(Date.now() - t0);
    }
    ctx.deleteTimings = deleteTimings;
    const after = await store.userCounts();
    is(after.hifzItems, before.hifzItems - removed, 'each removal through the UI removed exactly one stored item');
    ok(after.hifzItems === 0 || after.hifzItems < before.hifzItems, 'the hifz set really shrank', { before: before.hifzItems, after: after.hifzItems, removed });
    ok(after.attempts < before.attempts || after.attempts === 0, 'deleting an item took its stored attempts with it (the cascade the confirm text promises)', { before: before.attempts, after: after.attempts });
    ctx.deleted = { before, after, removed };
    const slowest = [...itemTimings, ...deleteTimings].sort((a, b) => (b.ms ?? b) - (a.ms ?? a))[0] ?? null;
    return `items ${before.hifzItems} → ${after.hifzItems} (${removed} removed) · attempts ${before.attempts} → ${after.attempts} · bookmarks ${before.bookmarks} → ${after.bookmarks} · per-row delete ms ${[...itemTimings.map((t) => t.ms), ...deleteTimings].join(', ')} · slowest ${JSON.stringify(slowest)}`;
  }, { skip: !store.supports('userCounts'), skipReason: store.unsupportedReason });

  await step('the backup restores what the UI deleted', 'device', async () => {
    await cdp.go('/me/backup');
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 40_000, label: 'backup screen' });
    const selected = await cdp.evaluate(`(function(){
      const rows = Array.from(document.querySelectorAll('li'));
      const row = rows.find((li)=>(li.textContent||'').includes(${JSON.stringify(backupName)}));
      if (!row) return 'row-missing';
      const b = Array.from(row.querySelectorAll('button')).find((x)=>/برای بازیابی انتخاب کن|Select to restore/.test((x.textContent||'').trim()));
      if (!b) return 'button-missing';
      b.click();
      return 'selected';
    })()`);
    is(selected, 'selected', `the written backup ${backupName} is listed and selectable`);
    await cdp.waitFor(`!!document.querySelector('.confirm__arm input[type=checkbox]')`, { timeoutMs: 30_000, label: 'the replace-data confirmation' });
    const title = await cdp.textOf('.confirm__title');
    includes(String(title), 'جایگزینی دادهٔ فعلی', 'the confirmation says exactly what it will do');
    await cdp.evaluate(`(function(){document.querySelector('.confirm__arm input[type=checkbox]').click();return 'ok';})()`);
    const restoredWall = Date.now();
    await cdp.clickText('بازیابی کن|Restore it');
    // Wait on the app’s own rows, not on a spinner: the point of the restore is
    // that what the UI deleted is back in storage. The shell reloads itself as soon
    // as the restore reports success, so the CDP socket dies mid-wait; the loop
    // re-attaches rather than assuming one reload happened.
    let backInMs = null;
    let lastCounts = null;
    while (Date.now() - restoredWall < 120_000) {
      try {
        lastCounts = await store.userCounts();
        if (lastCounts.hifzItems >= ctx.deleted.before.hifzItems && lastCounts.attempts >= ctx.deleted.before.attempts) {
          backInMs = Date.now() - restoredWall;
          break;
        }
      } catch {
        try {
          await cdp.connect({ timeoutMs: 8_000 });
          await cdp.startCapture({ intercept: opts.networkBlock });
        } catch {
          /* the shell is still reloading */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    ok(backInMs !== null, 'the restored rows are back in the app’s own storage', { waitedMs: Date.now() - restoredWall, lastCounts, deletedBefore: ctx.deleted.before });
    await cdp.go('/me/content');
    // The shell reloads itself after a restore, so the socket may be dead here;
    // settleOn re-reads the DOM each poll and reports the app's own error state
    // rather than a bare "the selector never appeared".
    const afterRestore = await settleOn('the shell after the restore', '.counts__item', { timeoutMs: 90_000 });
    return `restore round trip ${backInMs} ms (device-level wall clock, measured to the stored rows), shell reloaded and reopened (${afterRestore.waitedMs} ms to the counts table)`;
  }, { fatal: true });

  await step('the ayah is still weak in exactly the way it was', 'database', async () => {
    const snap = ctx.snapshot;
    ok(snap, 'the pre-backup snapshot exists', null);
    const now = await store.userSnapshot();
    const clean = (rows) => rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : v])));
    // Columns the engine stores as JSON text. A backup carries them as parsed
    // values, so the bytes that come back are ordered by the writer, not by the
    // reader: key order normalises, content does not. Applied to every field
    // whose cleaned value actually is a JSON object or array — the old hand-typed
    // list named `hifz_attempt.produced` and `errors` and missed
    // `hifz_segment.meaning`, which showed up as a lost round trip over nothing but
    // `{}` key order. A field that is not JSON is still compared byte for byte.
    const isJsonBlob = (value) => /^\s*[[{]/.test(String(value));
    const asCanonical = (value) => {
      try {
        return canonicalJsonStringify(JSON.parse(String(value)));
      } catch {
        return `unparseable:${String(value)}`;
      }
    };
    const compare = (name, keyFields) => {
      // Rows are paired by their own identity, not by position in a sorted list.
      // Sorting whole rows and walking both lists in step makes any single field
      // drift show up as "the first key differs" — which reads as a lost id when
      // what actually happened is that one row re-ordered. Keyed by identity, a
      // missing row says it is missing and a changed field names its row, while
      // the round trip is still required to be byte-exact.
      const a = clean(snap[name]);
      const b = clean(now[name]);
      const keyOf = (row) => keyFields.map((field) => String(row[field])).join('|');
      const index = (rows, side) => {
        const seen = new Map();
        for (const row of rows) {
          const key = keyOf(row);
          ok(!seen.has(key), `${name}: ${side} has one row per ${keyFields.join('+')}`, key);
          seen.set(key, row);
        }
        return seen;
      };
      const before = index(a, 'the snapshot');
      const after = index(b, 'the restored store');
      const missing = [...before.keys()].filter((key) => !after.has(key));
      const extra = [...after.keys()].filter((key) => !before.has(key));
      eq(missing, [], `${name}: every row the snapshot had came back under the same identity`, missing.slice(0, 5));
      eq(extra, [], `${name}: the restore added no ${name} row the snapshot did not have`, extra.slice(0, 5));
      for (const key of [...before.keys()].sort((x, y) => x.localeCompare(y))) {
        const wasRow = before.get(key);
        const restoredRow = after.get(key);
        for (const field of Object.keys(wasRow)) {
          if (isJsonBlob(wasRow[field]) || isJsonBlob(restoredRow[field])) {
            eq(asCanonical(restoredRow[field]), asCanonical(wasRow[field]), `${name}[${key}].${field} parses to the same value after the round trip`);
          } else {
            eq(restoredRow[field], wasRow[field], `${name}[${key}].${field} survived the round trip unchanged`);
          }
        }
      }
    };
    // Each table's own identity, from `core/src/contracts/db.sql`. `id` is the
    // primary key everywhere except the join table and the settings map.
    const KEY_FIELDS = {
      bookmark: ['id'],
      note: ['id'],
      hifz_item: ['id'],
      hifz_attempt: ['id'],
      hifz_segment: ['id'],
      anchor_word: ['id'],
      hifz_transition: ['id'],
      confusion_group: ['id'],
      confusion_group_item: ['group_id', 'position'],
      settings: ['key'],
    };
    for (const name of Object.keys(KEY_FIELDS)) {
      if (snap[name] && now[name]) compare(name, KEY_FIELDS[name]);
    }
    const targetKey = String(ctx.weakKey ?? ctx.snapshot.hifz_item[0].verse_key);
    const item = now.hifz_item.find((row) => String(row.verse_key) === targetKey);
    ok(item, `the item for ${targetKey} is back`, now.hifz_item.map((r) => r.verse_key));
    const was = snap.hifz_item.find((row) => String(row.verse_key) === targetKey);
    is(String(item.band), String(was.band), 'the band is the one the engine had put it in');
    is(Number(item.stability), Number(was.stability), 'the stability is the number the engine had left');
    is(Number(item.error_count), Number(was.error_count), 'the error count is the one the failure produced');
    const attemptsNow = now.hifz_attempt.filter((row) => String(row.item_id) === String(was.id));
    const attemptsWere = snap.hifz_attempt.filter((row) => String(row.item_id) === String(was.id));
    is(attemptsNow.length, attemptsWere.length, 'the same number of attempts is stored for that item');
    const wrong = attemptsWere.find((row) => JSON.parse(String(row.errors)).length > 0);
    ok(wrong, 'the snapshot contains the failing attempt', attemptsWere.length);
    const same = attemptsNow.find((row) => String(row.id) === String(wrong.id));
    ok(same, 'the failing attempt row came back with its own id', attemptsNow.map((r) => r.id));
    eq(canonical(same.errors), canonical(wrong.errors), 'the classified errors are the same errors that were recorded before the backup');
    eq(canonical(same.produced), canonical(wrong.produced), 'the recitation that caused them is stored as it was said');
    ctx.weakAfterRestore = { verseKey: targetKey, band: String(item.band), stability: Number(item.stability), errorCount: Number(item.error_count), kinds: JSON.parse(String(wrong.errors)).map((e) => e.kind) };
    return `${targetKey}: band ${ctx.weakAfterRestore.band}, stability ${ctx.weakAfterRestore.stability}, error_count ${ctx.weakAfterRestore.errorCount}, kinds ${ctx.weakAfterRestore.kinds.join(', ')} — identical to the snapshot`;
  }, { skip: !store.supports('userSnapshot'), skipReason: store.unsupportedReason });

  await step('the weak spot is still on screen after the restore', 'device', async () => {
    await cdp.go('/hifz/weak');
    await cdp.waitFor(`!${LOADING}`, { timeoutMs: 60_000, label: 'weak screen after restore' });
    const body = await cdp.bodyText(4000);
    const key = ctx.weakAfterRestore?.verseKey ?? null;
    ok(!key || body.includes(key), `the weak screen still speaks about ${key}`, body.slice(0, 200));
    return key ? `${key} present on the weak screen` : 'weak screen rendered; no weak row was expected';
  });

  /* ------------------------------------------------------------- persistence */

  await step('a hard reload keeps the imported content and the restored rows', 'device', async () => {
    await cdp.reload({ ignoreCache: true });
    await cdp.go('/me/content');
    // Waiting only for "no spinner" cannot tell a loaded screen from one that has
    // not started, or from one that failed and is showing its error panel.
    const reloaded = await settleOn('the data-health counts after a hard reload', '.counts__item', { timeoutMs: 90_000 });
    const body = await cdp.bodyText(12_000);
    ok(!/وارد کردن بسته‌های محتوا|Import content packs/.test(body), 'the screen no longer offers a first-run import', body.slice(0, 200));
    const counts = await store.contentCounts();
    eq(counts, {
      surahs: expected.surahs,
      ayahs: expected.ayahs,
      words: expected.words,
      translations: expected.translations,
      tafsirs: expected.tafsirs,
      similar: expected.similar,
      packs: expected.packRows,
    }, 'content counts are unchanged by the reload');
    return `still ${counts.ayahs} ayahs / ${counts.words} words after a fresh document load`;
  }, { skip: !store.supports('contentCounts'), skipReason: store.unsupportedReason });

  await step('no page exception or console error was raised on the way', 'device', async () => {
    const exceptions = [...new Set(cdp.exceptions)];
    const consoleErrors = [...new Set(cdp.consoleErrors)];
    if (exceptions.length || consoleErrors.length) {
      throw new AssertionError('the shipped window stayed error-free', {
        expected: '0 exceptions and 0 console errors',
        actual: { exceptions: exceptions.slice(0, 5), consoleErrors: consoleErrors.slice(0, 5) },
      });
    }
    return `0 exceptions, 0 console errors across ${cdp.requests.length} observed requests`;
  });

  return ctx;
}

/** Search is its own short journey tail; kept separate so it can be re-run. */
export async function runSearchTail(ctx) {
  const { cdp, store, suite } = ctx;
  const packs = store.packs;

  /** Real words out of a stored translation row: letters and diacritics only. */
  const wordsOf = (text) =>
    String(text)
      .split(/\s+/)
      .map((raw) => raw.replace(/[^\p{L}\p{M}]+/gu, ''))
      .filter((word) => word.length >= 4);

  const enrolledKeys = [ctx.weakKey, ...(ctx.hifzKeys ?? [])].filter(Boolean);

  /**
   * A word the shipped packs really contain, read out of a translation row for one
   * of the ayat this journey enrolled. Nothing is typed in beside the evidence.
   * This exists because the tail used to ask for «بیمار» — assumed to be absent —
   * and report PASS over a screen that found nothing: `rows <= max(stored, 1)` is
   * satisfied by 0 ≤ 1, so the whole search journey proved only that the page had
   * loaded. A hit query derived from the corpus and a stated miss are both real
   * assertions; a silent zero is neither.
   */
  const needle = (() => {
    if (!packs) return null;
    for (const key of enrolledKeys) {
      for (const row of packs.translationsFor(String(key)) ?? []) {
        for (const word of wordsOf(row.text)) {
          if (packs.searchHits(word) >= 1) return word;
        }
      }
    }
    return null;
  })();

  /**
   * The miss is derived the same way, not remembered: take an Arabic-script word
   * the packs do hold and lengthen it with letters no pack puts after it, then
   * keep it only once the pack bound comes back zero. One script on purpose —
   * the index has separate Latin and Arabic paths, so a mixed query would test
   * the tokeniser rather than the empty result. The hard-coded «بیمار» this step
   * used to trust occurs 36 times in the Persian translations, so a correct app
   * was being judged against a guess about the data.
   */
  const miss = (() => {
    if (!packs) return null;
    const arabicWord = /^[؀-ۿ]+$/u;
    for (const key of enrolledKeys) {
      for (const row of packs.translationsFor(String(key)) ?? []) {
        for (const word of wordsOf(row.text)) {
          if (!arabicWord.test(word)) continue;
          const candidate = `${word}نبوده`;
          if (packs.searchHits(candidate) === 0) return { query: candidate, word };
        }
      }
    }
    return null;
  })();

  const ask = async (query) => {
    await cdp.go(`/discover?q=${encodeURIComponent(query)}`);
    await cdp.waitFor(`!document.querySelector('.state--loading')`, { timeoutMs: 60_000, label: 'search results' });
    const body = await cdp.bodyText(2500);
    ok(!/در حال|loading/i.test(body.slice(0, 120)), 'the result screen settled', body.slice(0, 120));
    const backend = await cdp.evaluate(`(function(){const el=document.querySelector('[data-testid="search-backend"]');return el?el.textContent.trim().slice(0,80):null;})()`);
    ok(backend, 'the screen states which backend answered', backend);
    const rows = await cdp.count('a.linkbtn[href*="#/quran/ayah/"]');
    const stored = await store.searchHits(query);
    return { backend, rows, stored, body };
  };

  await suite.step('a query the packs really contain finds stored ayat', 'device', async () => {
    const { backend, rows, stored } = await ask(needle);
    if (stored === null) return `backend ${backend}, ${rows} verse links for “${needle}” (row-level bound needs the desktop store)`;
    ok(rows >= 1, `“${needle}” is in the packs, so the search screen must list at least one verse`, { rows, storedBound: stored, backend });
    // The pack bound is a raw substring count over every translation and the
    // Uthmani text; the app's normalised index can only answer a subset of it.
    ok(rows <= Math.max(stored, 1), 'the rendered result links do not exceed what the packs hold', { rows, stored });
    return `backend “${backend}”, ${rows} verse link(s) for “${needle}” (pack bound ${stored})`;
  }, {
    skip: !store.supports('searchHits') || needle === null,
    skipReason: !store.supports('searchHits') ? store.unsupportedReason : 'no translation row in the installed packs offers a searchable word of four letters',
  });

  await suite.step('a query with nothing to find states that, in words', 'device', async () => {
    const { backend, rows, stored, body } = await ask(miss.query);
    ok(stored === 0, `the packs hold nothing for “${miss.query}”`, { stored, builtFrom: miss.word });
    ok(rows === 0, 'the absent query must not produce verse links out of a near match', { rows, stored, needle: miss.query });
    const stated = await cdp.evaluate(`!!document.querySelector('.state--empty')`);
    ok(stated, 'the screen says there is no result instead of showing a blank list', { body: body.slice(0, 200) });
    return `backend “${backend}”, 0 links for “${miss.query}” (built by negating “${miss.word}”), empty state stated`;
  }, {
    skip: !store.supports('searchHits') || miss === null,
    skipReason: !store.supports('searchHits') ? store.unsupportedReason : 'no translation word of the enrolled ayat could be lengthened into a query the packs provably do not hold',
  });
}
