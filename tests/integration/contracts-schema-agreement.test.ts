/**
 * Contract ↔ schema agreement guards. No browser, no mocks: the contract source
 * text, the authoritative DDL, the DDL embedded in the desktop build and the
 * migration chain are all read and compared as *data*.
 *
 * Why each of the three groups exists:
 *
 * 1. `RECALL_MODES` (TypeScript) and the `hifz_attempt.mode` CHECK (SQLite) are
 *    two copies of one vocabulary. A mode the contract allows and the DDL refuses
 *    is an attempt that throws at insert time — and because the attempt is the
 *    append-only evidence every stability number is computed from, that failure
 *    lands on the learner's save, not on a report. The comparison is *verbatim
 *    and ordered*, because a reordered list is how "we added a mode" turns into
 *    "we replaced one" without any diff in the middle.
 * 2. Every field of `HifzItem`, `HifzSegment` and `RecallAttempt` must have a
 *    column, and every hifz column must answer to a field. The first direction is
 *    the silent one: a field with no column is stored as nothing, read back as
 *    `undefined`, and the app keeps running while the datum does not exist.
 * 3. The migration chain must be strictly increasing and end at `SCHEMA_VERSION`.
 *    `ensureSchema` runs every step with `to > stored`, so a gap is not an error —
 *    it is a v1 database that skips the step it needed and then claims to be v3.
 *
 * The fourth block is the hazard the dual axis actually created: `schema.ts`
 * hand-copies two of these DDL bodies, because a table rebuild cannot re-read
 * `db.sql` at runtime. If the contract changes and the copy does not, every v1
 * file migrates into a shape no test ever read.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { RECALL_DIMENSION, RECALL_MODES, RECALL_MODE_SQL_LIST } from '@quran/core';

import { MIGRATIONS, SCHEMA_VERSION, splitStatements } from '../../desktop/src/db/schema';
import { SCHEMA_SQL } from '../../desktop/src/db/schema.generated';
import { readSchemaSql, repoPath } from '../helpers/repo';

/* ------------------------------------------------------------------- DDL parse */

const CONTRACT_DDL = readSchemaSql();

/** The one `CREATE TABLE <name>` statement, comments already stripped. */
function createStatement(table: string, sql = CONTRACT_DDL): string {
  const hit = splitStatements(sql).find((s) => new RegExp(`^CREATE TABLE ${table}\\b`, 'i').test(s));
  if (!hit) throw new Error(`db.sql declares no CREATE TABLE ${table}`);
  return hit;
}

/** The text between the outermost parentheses of a `CREATE TABLE` statement. */
function tableBody(statement: string): string {
  const open = statement.indexOf('(');
  const close = statement.lastIndexOf(')');
  if (open < 0 || close < open) throw new Error(`unparsable CREATE TABLE: ${statement.slice(0, 40)}…`);
  return statement.slice(open + 1, close);
}

/** Split a table body on commas that are not inside parentheses or a string. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of body) {
    if (ch === "'" && !escaped(body, current)) quoted = !quoted;
    if (!quoted) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** True when the quote just written is doubled (`''`), i.e. an escape, not a close. */
function escaped(_body: string, current: string): boolean {
  return current.endsWith("'");
}

const TABLE_LEVEL = /^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)\b/i;

/** One column declaration: `name TYPE … CHECK (…)`. */
function columnDeclarations(table: string, sql = CONTRACT_DDL): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of splitTopLevel(tableBody(createStatement(table, sql)))) {
    if (TABLE_LEVEL.test(part)) continue;
    const name = part.match(/^`?([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
    if (!name) throw new Error(`unparsable column declaration in ${table}: ${part.slice(0, 40)}…`);
    out.set(name, part.replace(/\s+/g, ' ').trim());
  }
  return out;
}

function columnNames(table: string, sql = CONTRACT_DDL): string[] {
  return [...columnDeclarations(table, sql).keys()];
}

/** The quoted list of an `IN (…)` inside a column's declaration. */
function checkList(table: string, column: string): string[] {
  const declaration = columnDeclarations(table).get(column);
  if (!declaration) throw new Error(`db.sql has no column ${table}.${column}`);
  const inList = declaration.match(/CHECK\s*\(\s*\w+\s+IN\s*\(([\s\S]*?)\)\s*\)/i);
  if (!inList) throw new Error(`${table}.${column} has no CHECK … IN (…) to compare against`);
  return inList[1]!
    .split(',')
    .map((token) => token.trim().replace(/^'(.*)'$/, '$1'))
    .filter((token) => token.length > 0);
}

/* --------------------------------------------------------------- contract parse */

const HIFZ_CONTRACT = readFileSync(repoPath('core', 'src', 'contracts', 'hifz.ts'), 'utf-8');

/**
 * The member names of one exported contract interface, taken from the contract
 * source rather than a hand-copied list — so adding a field to `HifzSegment` and
 * forgetting the column fails here instead of failing in the user's database.
 */
function contractFields(name: string): string[] {
  const body = HIFZ_CONTRACT.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1];
  if (body === undefined) throw new Error(`contracts/hifz.ts declares no export interface ${name}`);
  const fields = [...body.matchAll(/^\s{2}(?:readonly )?([A-Za-z][A-Za-z0-9_]*)\??\s*:/gm)].map((m) => m[1]!);
  expect(fields.length, `${name} parsed to no fields — the reader is broken, not the schema`).toBeGreaterThan(0);
  return fields;
}

/** `nextReviewAt` → `next_review_at`, `durationMs` → `duration_ms`. */
function toColumn(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/* ------------------------------------------------------------------- the guard */

describe('contract ↔ db.sql: the recall vocabulary is one list, not two', () => {
  it('RECALL_MODES appears verbatim (and in order) inside the hifz_attempt.mode CHECK', () => {
    const declared = RECALL_MODES.map((mode) => `'${mode}'`).join(',');
    const expected = `CHECK (mode IN (${declared}))`;
    expect(
      CONTRACT_DDL.includes(expected),
      `db.sql's mode CHECK is not the contract's list verbatim.\n  expected: ${expected}\n  in db.sql: ${
        (createStatement('hifz_attempt').match(/CHECK \(mode IN \([\s\S]*?\)\)/)?.[0] ?? 'no mode CHECK found') as string
      }`,
    ).toBe(true);

    // Ordered equality, so a replaced mode is reported as the pair it replaced.
    expect(checkList('hifz_attempt', 'mode')).toEqual([...RECALL_MODES]);
  });

  it('RECALL_MODE_SQL_LIST and RECALL_MODES are the same list, and no mode is dropped by the DDL', () => {
    expect([...RECALL_MODE_SQL_LIST]).toEqual([...RECALL_MODES]);
    const stored = checkList('hifz_attempt', 'mode');
    const missing = RECALL_MODES.filter((mode) => !stored.includes(mode));
    const extra = stored.filter((mode) => !RECALL_MODES.includes(mode as (typeof RECALL_MODES)[number]));
    expect(missing, `modes the contract allows but the DDL refuses: ${missing.join(', ')}`).toEqual([]);
    expect(extra, `modes the DDL admits but no contract mode names: ${extra.join(', ')}`).toEqual([]);
  });

  it('the mode CHECK does not leak the dimension vocabulary, and vice versa', () => {
    // `form`/`meaning` live in their own CHECK; if one list ever grows into the
    // other, an attempt can be stored with a mode that is not a mode.
    const modes = checkList('hifz_attempt', 'mode');
    const dimensions = checkList('hifz_attempt', 'dimension');
    expect(modes.some((mode) => dimensions.includes(mode))).toBe(false);
    expect(dimensions).toEqual([...new Set(Object.values(RECALL_DIMENSION))].sort());
  });

  it('the DDL the desktop build actually ships carries the same lists', () => {
    // `schema.generated.ts` is the string every real database is created from;
    // a stale copy means the shipped app refuses a mode this test just accepted.
    expect(SCHEMA_SQL.replace(/\r\n/g, '\n').trim(), 'the embedded DDL drifted from core/src/contracts/db.sql').toBe(
      CONTRACT_DDL.replace(/\r\n/g, '\n').trim(),
    );
    const declared = RECALL_MODES.map((mode) => `'${mode}'`).join(',');
    expect(SCHEMA_SQL).toContain(`CHECK (mode IN (${declared}))`);
  });
});

describe('contract ↔ db.sql: every contract field is a column, every column is a field', () => {
  /**
   * `HifzSegment.meaning` is one contract object flattened over four columns,
   * and the field names do not derive to the column names (`packId` is stored as
   * `meaning_pack`, `wordGloss` as `meaning_word_gloss`), so the pair is declared
   * here. A `SegmentMeaning` field that is not in this map fails the guard.
   */
  const SEGMENT_MEANING_COLUMNS: Record<string, string> = {
    text: 'meaning_text',
    lang: 'meaning_lang',
    packId: 'meaning_pack',
    wordGloss: 'meaning_word_gloss',
  };

  const FIELD_TO_COLUMNS: Record<string, (field: string) => string[]> = {
    HifzItem: (field) => [toColumn(field)],
    HifzSegment: (field) =>
      field === 'meaning'
        ? contractFields('SegmentMeaning').map((name) => {
            const column = SEGMENT_MEANING_COLUMNS[name];
            if (!column) throw new Error(`SegmentMeaning.${name} has no column mapped in this guard`);
            return column;
          })
        : [toColumn(field)],
    // `cue` is one object (kind/text/lang/packId) stored as one JSON TEXT column,
    // so it maps to exactly `cue` — the flattening that matters is `meaning`.
    RecallAttempt: (field) => [toColumn(field)],
  };

  const CASES: { contract: string; table: string }[] = [
    { contract: 'HifzItem', table: 'hifz_item' },
    { contract: 'HifzSegment', table: 'hifz_segment' },
    { contract: 'RecallAttempt', table: 'hifz_attempt' },
  ];

  for (const { contract, table } of CASES) {
    it(`${contract}: each field has a column in ${table}`, () => {
      const columns = columnNames(table);
      const map = FIELD_TO_COLUMNS[contract]!;
      const holes: string[] = [];
      for (const field of contractFields(contract)) {
        for (const column of map(field)) {
          if (!columns.includes(column)) holes.push(`${contract}.${field} → ${table}.${column}`);
        }
      }
      expect(holes, `fields the contract declares with nowhere to be stored:\n  ${holes.join('\n  ')}`).toEqual([]);
    });

    it(`${table}: each column answers to a field of ${contract}`, () => {
      const toColumns = FIELD_TO_COLUMNS[contract]!;
      const expected = new Set(contractFields(contract).flatMap((field) => toColumns(field)));
      const orphaned = columnNames(table).filter((column) => !expected.has(column));
      // A column no field explains is either a leftover of a rename (the dual
      // axis renamed `meaning_fa`/`meaning_source` → `meaning_*`) or a field the
      // contract lost; both mean the gateway and the DDL disagree about a row.
      expect(orphaned, `columns in ${table} that ${contract} cannot fill: ${orphaned.join(', ')}`).toEqual([]);
    });
  }

  it('SegmentMeaning is exactly the four columns hifz_segment gives a meaning', () => {
    // Nothing about this object derives: `packId` → `meaning_pack` is a naming
    // decision, so the guard states both sides and refuses a fourth reading.
    expect(contractFields('SegmentMeaning').map((name) => SEGMENT_MEANING_COLUMNS[name] ?? `??${name}`)).toEqual([
      'meaning_text',
      'meaning_lang',
      'meaning_pack',
      'meaning_word_gloss',
    ]);
    expect(columnNames('hifz_segment')).toEqual(
      expect.arrayContaining(Object.values(SEGMENT_MEANING_COLUMNS)),
    );
    // The lang CHECK is the contract's own union, in the contract's own order.
    expect(checkList('hifz_segment', 'meaning_lang')).toEqual(['fa', 'ar', 'en']);
  });

  it('the dual axis is stored on both tables the contract puts it on', () => {
    expect(columnNames('hifz_item')).toEqual(
      expect.arrayContaining(['stability', 'form_stability', 'meaning_stability']),
    );
    expect(columnNames('hifz_segment')).toEqual(expect.arrayContaining(['stability', 'meaning_stability']));
    expect(columnNames('hifz_attempt')).toEqual(expect.arrayContaining(['dimension']));
  });
});

describe('migration chain: it reaches SCHEMA_VERSION and skips nothing', () => {
  it('SCHEMA_VERSION matches the version line of the contract DDL', () => {
    const declared = CONTRACT_DDL.match(/-- SQLite schema, version (\d+)/)?.[1];
    expect(declared, 'db.sql header does not state a version').toBeDefined();
    expect(SCHEMA_VERSION, `db.sql says v${declared}, schema.ts says v${SCHEMA_VERSION}`).toBe(Number(declared));
  });

  it('the `to` values are strictly increasing and end at SCHEMA_VERSION', () => {
    const tos = MIGRATIONS.map((m) => m.to);
    for (let i = 1; i < tos.length; i += 1) {
      expect(tos[i]! > tos[i - 1]!, `chain is not strictly increasing at step ${i}: ${tos.join(', ')}`).toBe(true);
    }
    expect(tos.at(-1), `the chain ends at v${tos.at(-1)} but SCHEMA_VERSION is v${SCHEMA_VERSION}`).toBe(SCHEMA_VERSION);
    expect(new Set(tos).size).toBe(tos.length);
  });

  it('the chain is contiguous from v1, so no stored version can skip a step', () => {
    // `ensureSchema` runs every step with `to > stored`. A gap (1 → 3) means a v1
    // file jumps straight over v2 and is then stamped version 3 anyway.
    const expected = Array.from({ length: SCHEMA_VERSION - 1 }, (_, i) => i + 2);
    expect(MIGRATIONS.map((m) => m.to), `missing or extra steps for a v1 database`).toEqual(expected);
  });

  it('every step is an implemented upgrade with a description a log can show', () => {
    for (const step of MIGRATIONS) {
      expect(typeof step.up, `migration to v${step.to} has no up()`).toBe('function');
      expect(step.describe.length, `migration to v${step.to} has no description`).toBeGreaterThan(10);
    }
  });
});

describe('the hand-copied rebuild bodies still match the contract', () => {
  /**
   * `desktop/src/db/schema.ts` cannot import `db.sql` at runtime, so the v2→
   * rebuild of `hifz_segment` and `hifz_attempt` carries a copy of their DDL.
   * These assertions are the copy's leash: read the source text and compare the
   * column lists it names against the contract they came from.
   */
  const schemaSource = readFileSync(repoPath('desktop', 'src', 'db', 'schema.ts'), 'utf-8');

  function copiedColumnList(constName: string): string[] {
    const literal = schemaSource.match(new RegExp(`${constName}\\s*=?\\s*\\[([\\s\\S]*?)\\]`))?.[1];
    if (literal === undefined) throw new Error(`schema.ts no longer declares ${constName}`);
    return [...literal.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  }

  function copiedTableBody(constOrFnName: string): string[] {
    // The DDL copy lives in a template literal in schema.ts, so the pattern has
    // to name a backtick — built by char code, because an escaped backtick is
    // not valid inside a JS regexp literal and this file must stay parsable.
    const tick = String.fromCharCode(96);
    const body = schemaSource.match(new RegExp(constOrFnName + '[\\s\\S]{0,80}?' + tick + '\\(([\\s\\S]*?)\\)' + tick))?.[1];
    if (body === undefined) throw new Error(`schema.ts no longer carries the ${constOrFnName} DDL copy`);
    return splitTopLevel(body)
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter((part) => !TABLE_LEVEL.test(part))
      .map((part) => part.match(/^`?([A-Za-z_][A-Za-z0-9_]*)/)![1]!);
  }

  /**
   * The columns the contract has *now*, minus the ones a given version could not
   * have installed. A hand-copied historical DDL is frozen: bumping the contract
   * must not retroactively make the v2 copy wrong, or the guard people rely on to
   * catch a real drift becomes a test that fails for the right reason and gets
   * widened until it means nothing.
   */
  function contractColumnsOf(table: string, sinceVersion: number): string[] {
    const addedLater: Record<number, string[]> = {
      // v3 gave every fingerprint row its ayah.
      3: ['verse_key'],
    };
    const later = Object.keys(addedLater)
      .map(Number)
      .filter((version) => version > sinceVersion)
      .flatMap((version) => addedLater[version]!);
    return columnNames(table).filter((column) => !later.includes(column));
  }

  it('HIFZ_SEGMENT_V2_COLUMNS is the v2 contract hifz_segment, in contract order', () => {
    const v2 = contractColumnsOf('hifz_segment', 2);
    expect(copiedColumnList('HIFZ_SEGMENT_V2_COLUMNS')).toEqual(v2);
    expect(copiedTableBody('HIFZ_SEGMENT_V2_BODY')).toEqual(v2);
    // The one column the copy lacks is the one v3 adds, and it is named above.
    expect(columnNames('hifz_segment')).toEqual(expect.arrayContaining([...v2, 'verse_key']));
  });

  it('HIFZ_ATTEMPT_V2_COLUMNS is the contract hifz_attempt, in contract order', () => {
    expect(copiedColumnList('HIFZ_ATTEMPT_V2_COLUMNS')).toEqual(columnNames('hifz_attempt'));
    expect(copiedTableBody('hifzAttemptV2Body')).toEqual(columnNames('hifz_attempt'));
  });

  for (const table of ['hifz_segment', 'anchor_word', 'hifz_transition'] as const) {
    it(`the v3 rebuild copy of ${table} is the contract, in contract order`, () => {
      // v3's copies live inside the `FINGERPRINT_V3` array, so they are read out
      // per entry rather than by constant name.
      const tick = String.fromCharCode(96);
      const match = schemaSource.match(
        new RegExp(`table: '${table}'([\\s\\S]*?)\\n  }`),
      )?.[1];
      if (match === undefined) throw new Error(`schema.ts no longer carries the v3 copy of ${table}`);
      const columns = match.match(new RegExp(`columns: \\[([\\s\\S]*?)\\]`))?.[1];
      const body = match.match(new RegExp(`body: ${tick}\\(([\\s\\S]*?)\\)${tick}`))?.[1];
      if (columns === undefined || body === undefined) {
        throw new Error(`the v3 copy of ${table} no longer declares both its column list and its DDL`);
      }
      const expected = columnNames(table);
      expect([...columns.matchAll(/'([^']+)'/g)].map((m) => m[1]!), `${table} column list`).toEqual(expected);
      expect(
        splitTopLevel(body)
          .map((part) => part.replace(/\s+/g, ' ').trim())
          .filter((part) => !TABLE_LEVEL.test(part))
          .map((part) => part.match(/^`?([A-Za-z_][A-Za-z0-9_]*)/)![1]!),
        `${table} DDL body`,
      ).toEqual(expected);
    });
  }

  it('the rebuild generates the mode CHECK from RECALL_MODES instead of a second literal list', () => {
    // Two literals of one enum is how they drift; the generated body must be
    // built from the contract array so this test cannot go stale quietly.
    expect(schemaSource).toMatch(/function hifzAttemptV2Body\(modes/);
    expect(schemaSource).toMatch(/core\.RECALL_MODES|RECALL_MODES/);
    expect(/mode TEXT NOT NULL CHECK \(mode IN \('segment'/.test(schemaSource), 'schema.ts hard-codes the mode list').toBe(false);
  });
});
