# Audio licences — STUB

**No audio is bundled.** No recitation files have been downloaded, and no
audio pack exists in `content/`. The `audio` kind in `ContentPackManifest`
and the `audio_track` table in `db.sql` are placeholders for a future round.

When audio is added, each bundleable recitation must ship as its own pack
with a real per-reciter/per-edition licence record — never one blanket
statement. At minimum:

1. **The recitation recording itself.** Rights sit with the reciter or the
   producing publisher. Quran.com serves many recitations, but its developer
   terms ("QF Content is not sold, sublicensed, or redistributed"; storage >
   1 week requires permission) mean **serving ≠ redistribution right** — a
   written grant per reciter/publisher is required, exactly like translations.
   Known-safe starting point to investigate: recitations explicitly released
   by their rights holders for free distribution (each must still be
   verified individually and archived as evidence).
2. **Mushaf alignment/audio files (if used).** Tarteel and similar
   word-sync datasets have their own terms; verify before use.
3. **Attribution display.** Quran Foundation terms require crediting named
   sources wherever content is surfaced; every audio pack's
   `attribution.creditLine` must be rendered in the UI (About + player).

Until a licence is confirmed for a specific recitation, its pack's
`license.status` must be `unresolved` and the audio must not ship in the
installer. The content build already fails loudly on missing provenance —
audio must go through the same fetch → validate → build gates.
