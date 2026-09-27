# Architecture

## Shape

Three layers, one direction of dependency:

```
content packs (built offline, checksummed)
        ↓ imported once, then read-only
SQLite (Tauri: tauri-plugin-sql/sqlite · Flutter: sqflite)
        ↓ repositories
@quran/core  ← framework-free: contracts, normalisation, hifz engine,
               search, similarity, integrity, backup
        ↓ consumed by
desktop (React UI + Tauri shell)      mobile (Flutter UI, phase 2)
```

`@quran/core` holds every decision that must be identical on both platforms:
what counts as the same word, how an error is classified, how review priority
is computed. UI layers never implement engine logic; they render engine output.
The Dart port mirrors `core/src/contracts` and is validated against the same
fixtures, so a desktop and a phone recitation score identically.

## Content pipeline

`tools/content` is the only component allowed to touch the network, and only at
build time:

```
fetch   → data/raw/<provider>/<endpoint>.json  (never rewritten in place)
validate → integrity gate: 114 surahs, 6236 ayahs, contiguous verse keys,
           unique ids, no empty text, provider counts match, alignment proven
build    → content/<pack>/pack.json + payload.jsonl, sha256 checksum
import   → SQLite content tables (transactional; abort leaves DB untouched)
```

A pack whose checksum fails is never imported and never displayed.

## Persistence

One SQLite file per app install. Content tables are replaceable; user tables
are precious. Backup exports user tables only (`BackupEnvelope`, checksummed,
versioned, migratable). Restore validates the envelope before writing, and
writes inside a transaction.

## Hifz engine

Pure functions over stored rows — no timers, no randomness without a seeded
generator, no clock reads (timestamps are passed in). That makes every
scenario reproducible in a test: given these attempts on these dates, the
scheduler must produce exactly this queue.

```
ayah text ──► segmentation ──► anchors ──► transitions
                                          │
recited words ──► normalisation ──► classify ──► attempt ──► stability
                                                     │
                              adaptive review queue ◄─┘
```

## Search

FTS5 over normalised Arabic plus each bundled translation, with the
normalisation shared from `core`. Root and concept search are separate indexes
built from packs, never guessed at query time.

## Optional local AI

Off by default, additive when present. Nothing required to read, search, or
memorise may depend on it.
