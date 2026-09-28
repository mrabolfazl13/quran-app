/**
 * Mushaf layout engine: Madani 604-page grid built from the provider's per-word
 * page/line metadata. Pure data in, pure data out — desktop, web and the Dart
 * port all consume this module unchanged.
 *
 * See `docs/mushaf-layout.md` for the metadata's provenance, the invariant list
 * and the `unplaced` policy.
 */

export * from './layout.js';
export * from './render.js';
export * from './validate.js';
