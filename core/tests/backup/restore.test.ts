import { describe, expect, it } from 'vitest';
import type { BackupEnvelope } from '../../src/contracts/backup';
import { buildEnvelope, computeDataChecksum, serializeEnvelope } from '../../src/backup/export';
import { applyRestore, planRestore, RESTORE_TABLES } from '../../src/backup/restore';
import { inspectEnvelope } from '../../src/backup/validate';
import {
  driver,
  failingAt,
  makeDb,
  META,
  readUserRows,
  reseal,
  sampleEnvelope,
  tableCounts,
  USER_TABLES,
} from './fixtures';

function freshApply(env: BackupEnvelope) {
  const db = makeDb();
  return { db, run: () => applyRestore(driver(db), env) };
}

describe('planRestore', () => {
  it('lists exactly the user tables, with rows to write and rows to replace', () => {
    const env = sampleEnvelope();
    const plan = planRestore(env, { note: 3, hifz_item: 9, hifz_attempt: 2 });
    expect(plan.tables.map((t) => t.table)).toEqual([...RESTORE_TABLES]);
    expect(plan.tables.every((t) => t.table.startsWith('content') === false)).toBe(true);
    const note = plan.tables.find((t) => t.table === 'note')!;
    expect(note.rows).toBe(1);
    expect(note.replacing).toBe(3);
    const items = plan.tables.find((t) => t.table === 'hifz_item')!;
    expect(items.rows).toBe(2);
    expect(items.replacing).toBe(9);
    expect(plan.orphans).toEqual([]);
    expect(plan.settings.accepted).toContain('theme');
    expect(plan.checksum).toBe(env.checksum);
  });

  it('reports what would be orphaned before anything is written', () => {
    const env = sampleEnvelope();
    (env.data.recallAttempts[0] as Record<string, unknown>).itemId = 'gone';
    const plan = planRestore(reseal(env), {});
    expect(plan.orphans).toHaveLength(1);
    expect(plan.orphans[0]!.missing).toContain('gone');
    expect(plan.warnings.join(' ')).toContain('drop-orphans');
  });

  it('plan flags settings an arbitrary file tried to smuggle', () => {
    const env = sampleEnvelope();
    (env.data.settings as Record<string, unknown>).evilKey = 'x';
    const plan = planRestore(reseal(env), {});
    expect(plan.settings.rejected.map((r) => r.key)).toEqual(['evilKey']);
    expect(plan.settings.accepted).not.toContain('evilKey');
  });
});

describe('applyRestore — real node:sqlite database', () => {
  it('writes everything in one transaction and the counts confirm', async () => {
    const env = sampleEnvelope();
    const { db, run } = freshApply(env);
    const result = await run();
    // the failure object is the whole diagnosis, so print it instead of a bare
    // `false to be true` that leaves the next reader guessing
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.verified.note).toBe(1);
    expect(result.verified.hifz_attempt).toBe(3);
    expect(result.verified.confusion_group_item).toBe(2);
    expect(result.verified.journey_progress).toBe(2);
    for (const table of USER_TABLES) {
      expect(tableCounts(db)[table]).toBe(result.verified[table]);
    }
    db.close();
  });

  it('export → validate → restore → read → export is byte-identical canonical JSON', async () => {
    const env1 = sampleEnvelope();
    expect(inspectEnvelope(serializeEnvelope(env1)).ok).toBe(true);
    const { db, run } = freshApply(env1);
    const result = await run();
    expect(result.ok).toBe(true);
    const rows2 = readUserRows(db);
    const env2 = buildEnvelope(rows2, META).envelope;
    expect(serializeEnvelope(env2)).toBe(serializeEnvelope(env1));
    db.close();
  });

  it('restores both memory axes, a licensed segment meaning, and the attempt dimension', async () => {
    const { db, run } = freshApply(sampleEnvelope());
    expect((await run()).ok).toBe(true);

    const columns = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
    // the composite is the weaker axis, and both numbers travel with it
    expect(columns(`SELECT stability, form_stability, meaning_stability FROM hifz_item WHERE id = 'item-1'`)).toEqual([
      { stability: 0.5, form_stability: 0.6, meaning_stability: 0.5 },
    ]);
    expect(
      columns(`SELECT meaning_stability FROM hifz_item WHERE id = 'item-2'`)[0]!.meaning_stability,
      'an item nobody ever probed for meaning must not come back as probed-and-failed',
    ).toBeNull();

    expect(
      columns(
        `SELECT meaning_text, meaning_lang, meaning_pack, meaning_word_gloss, meaning_stability
         FROM hifz_segment WHERE id = 'seg-1'`,
      ),
    ).toEqual([
      {
        meaning_text: 'in the name of God',
        meaning_lang: 'en',
        meaning_pack: 'word-data',
        meaning_word_gloss: 1,
        meaning_stability: 0.4,
      },
    ]);
    // a chunk no pack covers keeps all four columns empty — restore invents nothing
    expect(
      columns(
        `SELECT meaning_text, meaning_lang, meaning_pack, meaning_word_gloss, meaning_stability
         FROM hifz_segment WHERE id = 'seg-2'`,
      ),
    ).toEqual([
      { meaning_text: null, meaning_lang: null, meaning_pack: null, meaning_word_gloss: 0, meaning_stability: null },
    ]);

    expect(columns(`SELECT id, mode, dimension FROM hifz_attempt ORDER BY id`)).toEqual([
      { id: 'att-1', mode: 'full-ayah', dimension: 'form' },
      { id: 'att-2', mode: 'segment', dimension: 'form' },
      { id: 'att-3', mode: 'meaning-to-arabic', dimension: 'meaning' },
    ]);
    const cue = columns(`SELECT cue FROM hifz_attempt WHERE id = 'att-3'`)[0]!.cue;
    expect(JSON.parse(String(cue))).toEqual({
      kind: 'meaning-gloss',
      text: 'in the name of God',
      lang: 'en',
      packId: 'word-data',
    });
    db.close();
  });

  it('a file written before the dual-axis contract still restores: form = composite, meaning = NULL, axis from the mode', async () => {
    const env = sampleEnvelope();
    for (const rows of [env.data.hifzItems, env.data.hifzSegments, env.data.recallAttempts] as Array<
      Array<Record<string, unknown>>
    >) {
      for (const r of rows) {
        delete r.formStability;
        delete r.meaningStability;
        delete r.meaning;
        delete r.dimension;
      }
    }
    const { db, run } = freshApply(reseal(env));
    const result = await run();
    expect(result.ok, JSON.stringify(result)).toBe(true);

    const items = db.prepare(
      'SELECT id, stability, form_stability, meaning_stability FROM hifz_item ORDER BY id',
    ).all() as Array<Record<string, unknown>>;
    expect(items).toEqual([
      { id: 'item-1', stability: 0.5, form_stability: 0.5, meaning_stability: null },
      { id: 'item-2', stability: 0, form_stability: 0, meaning_stability: null },
    ]);
    // `dimension` is NOT NULL, so this is the row the restore had to fill in —
    // from the mode, which is why a meaning drill is not relabelled as recall.
    const attempts = db.prepare('SELECT id, dimension FROM hifz_attempt ORDER BY id').all();
    expect(attempts).toEqual([
      { id: 'att-1', dimension: 'form' },
      { id: 'att-2', dimension: 'form' },
      { id: 'att-3', dimension: 'meaning' },
    ]);
    const segments = db
      .prepare('SELECT meaning_text, meaning_pack, meaning_word_gloss FROM hifz_segment ORDER BY id')
      .all() as Array<Record<string, unknown>>;
    expect(segments.map((s) => [s.meaning_text, s.meaning_pack, s.meaning_word_gloss])).toEqual([
      [null, null, 0],
      [null, null, 0],
    ]);
    db.close();
  });

  it('restoring twice replaces rather than duplicates (replace-all semantics)', async () => {
    const env = sampleEnvelope();
    const { db, run } = freshApply(env);
    expect((await run()).ok).toBe(true);
    const second = await run();
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.verified.note).toBe(1);
    db.close();
  });

  it('a restore over old data removes rows the new backup does not carry', async () => {
    const db = makeDb();
    const envA = sampleEnvelope();
    expect((await applyRestore(driver(db), envA)).ok).toBe(true);
    const envB = structuredClone(envA);
    envB.data.bookmarks = [envB.data.bookmarks[0]!];
    const res = await applyRestore(driver(db), reseal(envB));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.verified.bookmark).toBe(1);
    const rows = db.prepare('SELECT id FROM bookmark ORDER BY id').all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['bm-1']);
    db.close();
  });

  it('rolls back completely when the write is killed mid-flight — DB unchanged', async () => {
    const db = makeDb();
    expect((await applyRestore(driver(db), sampleEnvelope())).ok).toBe(true);
    const before = tableCounts(db);

    // A new envelope that would wipe and rewrite everything, killed on the
    // 25th statement run (somewhere inside the INSERT phase).
    const env2 = sampleEnvelope();
    (env2.data.notes[0] as Record<string, unknown>).body = 'REPLACED BODY';
    const killer = failingAt(driver(db), 25, () => undefined);
    const res = await applyRestore(killer, reseal(env2));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.phase).toBe('write');
      expect(res.rolledBack).toBe(true);
      expect(res.message).toContain('injected failure');
    }
    expect(tableCounts(db)).toEqual(before);
    const note = db.prepare('SELECT body FROM note WHERE id = ?').get('note-1') as { body: string };
    expect(note.body).toContain('al-Fatiha'); // original survived
    db.close();
  });

  it('FK violation (content ayah missing from this install) rolls back, user tables untouched', async () => {
    // Fresh DB whose corpus lacks 112:2, which the backup's reading history
    // references → the INSERT must abort and the whole transaction roll back.
    const db = makeDb();
    db.exec("DELETE FROM ayah WHERE verse_key = '112:2'");
    const res = await applyRestore(driver(db), sampleEnvelope());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.rolledBack).toBe(true);
    const after = tableCounts(db);
    for (const table of USER_TABLES) expect(after[table]).toBe(0);
    const ayahs = (db.prepare('SELECT COUNT(*) AS n FROM ayah').get() as { n: number }).n;
    expect(ayahs).toBe(12); // content still exactly as this install shipped it
    db.close();
  });

  it('re-verifies the checksum itself — a mutated envelope cannot sneak past the caller', async () => {
    const db = makeDb();
    expect((await applyRestore(driver(db), sampleEnvelope())).ok).toBe(true);
    const before = tableCounts(db);

    const evil = sampleEnvelope();
    (evil.data.notes[0] as Record<string, unknown>).body = 'INJECTED'; // checksum NOT recomputed
    const res = await applyRestore(driver(db), evil);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.phase).toBe('verify');
      expect(res.errors.some((e) => e.code === 'checksum-mismatch')).toBe(true);
    }
    expect(tableCounts(db)).toEqual(before);
    db.close();
  });

  it('orphaned attempts abort the restore, unless the user confirmed drop-orphans', async () => {
    const env = sampleEnvelope();
    (env.data.recallAttempts[1] as Record<string, unknown>).itemId = 'ghost';
    const sealed = reseal(env);

    const refused = await applyRestore(driver(makeDb()), sealed);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.errors.some((e) => e.code === 'dangling-reference')).toBe(true);
    }

    const dropped = await applyRestore(driver(makeDb()), sealed, { dropOrphans: true });
    expect(dropped.ok).toBe(true);
    if (dropped.ok) {
      expect(dropped.verified.hifz_attempt).toBe(2);
      expect(dropped.droppedOrphans).toHaveLength(1);
      expect(dropped.droppedOrphans[0]!.missing).toContain('ghost');
    }
  });

  it('the settings allowlist is enforced at write time; unknown keys never reach the DB', async () => {
    const env = sampleEnvelope();
    (env.data.settings as Record<string, unknown>).evilKey = 'injected';
    (env.data.settings as Record<string, unknown>).theme = 'hot-pink'; // invalid enum value
    const res = await applyRestore(driver(makeDb()), reseal(env));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.settingsRejected.map((r) => r.key).sort()).toEqual(['evilKey', 'theme']);
    expect(res.verified.settings).toBe(6); // 7 minus the invalid theme value
  });

  it('never touches content tables, even if a hostile file smuggles them into data', async () => {
    const db = makeDb();
    const beforeAyah = db.prepare("SELECT text_uthmani FROM ayah WHERE verse_key = '1:1'").get() as { text_uthmani: string };
    const beforeCount = (db.prepare('SELECT COUNT(*) AS n FROM ayah').get() as { n: number }).n;

    const env = sampleEnvelope();
    (env.data as unknown as Record<string, unknown>).ayah = [
      { verseKey: '1:1', textUthmani: 'FORGED TEXT', chapter: 1, verse: 1 },
    ];
    const sealed = reseal(env);
    // validate: keeps the sealed bytes but warns the key is not user data
    const inspection = inspectEnvelope(serializeEnvelope(sealed));
    expect(inspection.ok).toBe(true);
    if (inspection.ok) expect(inspection.warnings.some((w) => w.includes('ayah'))).toBe(true);

    const res = await applyRestore(driver(db), sealed);
    expect(res.ok).toBe(true);
    const afterAyah = db.prepare("SELECT text_uthmani FROM ayah WHERE verse_key = '1:1'").get() as { text_uthmani: string };
    expect(afterAyah.text_uthmani).toBe(beforeAyah.text_uthmani);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ayah').get() as { n: number }).n).toBe(beforeCount);
    db.close();
  });

  it('empty-but-valid backup legitimately empties the user tables', async () => {
    const db = makeDb();
    expect((await applyRestore(driver(db), sampleEnvelope())).ok).toBe(true);
    const empty = buildEnvelope({}, META).envelope;
    const res = await applyRestore(driver(db), empty);
    expect(res.ok).toBe(true);
    if (res.ok) {
      for (const table of USER_TABLES) expect(res.verified[table]).toBe(0);
    }
    db.close();
  });

  it('a hostile pre-migration envelope cannot be applied directly (validate gate)', async () => {
    const env = sampleEnvelope();
    const future = { ...reseal(env), schemaVersion: 2 };
    const inspection = inspectEnvelope(serializeEnvelope(future));
    expect(inspection.ok).toBe(false); // must go through validate+migrate
    const res = await applyRestore(driver(makeDb()), future);
    expect(res.ok).toBe(false); // applyRestore re-validates too
  });
});

describe('checksum definition spot-check', () => {
  it('is sha256 over the canonical JSON of data, reproducible', () => {
    const env = sampleEnvelope();
    const dataJson = serializeEnvelope(env); // contains data canonically
    expect(env.checksum).toBe(computeDataChecksum(env.data));
    expect(dataJson).toContain(env.checksum);
  });
});
