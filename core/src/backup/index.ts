/**
 * Backup & persistence — public surface.
 *
 * Pure, database-agnostic, framework-free: rows in / rows out, so both
 * `node:sqlite` (tests) and Tauri's async plugin-sql (desktop) can drive it.
 * Wire format and threat model: `docs/backup-format.md`.
 */

export * from './canonical-json';
export * from './sha256';
export * from './types';
export * from './settings';
export * from './export';
export * from './validate';
export * from './migrate';
export * from './migrations/v1-to-v2';
export * from './restore';
