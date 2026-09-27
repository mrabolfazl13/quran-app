-- SQLite schema, version 1.
-- Content tables are populated from validated content packs and are read-only
-- at runtime. User tables hold everything the backup exports.
-- Identity rule: verse_key / surah number / page number are the stable keys.
-- Row `id` columns sourced from a provider are kept as `source_id` and are
-- never used as a foreign key.

PRAGMA foreign_keys = ON;

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- content

CREATE TABLE content_pack (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  language TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  license_name TEXT NOT NULL,
  license_spdx TEXT,
  license_status TEXT NOT NULL CHECK (license_status IN ('clear','attribution-required','unresolved')),
  license_notes TEXT NOT NULL,
  attribution TEXT NOT NULL,
  checksum TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE surah (
  number INTEGER PRIMARY KEY,
  name_arabic TEXT NOT NULL,
  name_simple TEXT NOT NULL,
  name_transliterated TEXT NOT NULL,
  translation_fa TEXT,
  translation_en TEXT,
  revelation_place TEXT NOT NULL CHECK (revelation_place IN ('makkah','madinah')),
  revelation_order INTEGER NOT NULL,
  ayah_count INTEGER NOT NULL,
  pages_from INTEGER NOT NULL,
  pages_to INTEGER NOT NULL,
  first_verse_key TEXT NOT NULL,
  last_verse_key TEXT NOT NULL,
  bismillah_pre INTEGER NOT NULL CHECK (bismillah_pre IN (0,1))
);

CREATE TABLE ayah (
  verse_key TEXT PRIMARY KEY,
  chapter INTEGER NOT NULL REFERENCES surah(number),
  verse INTEGER NOT NULL,
  source_id INTEGER,
  juz INTEGER NOT NULL,
  hizb INTEGER NOT NULL,
  rub_el_hizb INTEGER NOT NULL,
  sajda INTEGER,
  ruku INTEGER,
  manzil INTEGER,
  page INTEGER NOT NULL,
  text_uthmani TEXT NOT NULL,
  text_uthmani_simple TEXT,
  word_count INTEGER NOT NULL,
  normalized_hash TEXT NOT NULL
);
CREATE UNIQUE INDEX ayah_order_idx ON ayah(chapter, verse);
CREATE INDEX ayah_page_idx ON ayah(page);
CREATE INDEX ayah_juz_idx ON ayah(juz);
CREATE INDEX ayah_hizb_idx ON ayah(hizb);

CREATE TABLE ayah_word (
  id INTEGER PRIMARY KEY,
  verse_key TEXT NOT NULL REFERENCES ayah(verse_key),
  position INTEGER NOT NULL,
  text_uthmani TEXT NOT NULL,
  translation_en TEXT,
  transliteration TEXT,
  root TEXT,
  morphology TEXT,
  is_end_of_ayah_mark INTEGER NOT NULL DEFAULT 0,
  normalized TEXT NOT NULL
);
CREATE UNIQUE INDEX ayah_word_pos_idx ON ayah_word(verse_key, position);

CREATE TABLE translation (
  verse_key TEXT NOT NULL REFERENCES ayah(verse_key),
  pack_id TEXT NOT NULL REFERENCES content_pack(id),
  text TEXT NOT NULL,
  PRIMARY KEY (verse_key, pack_id)
);

CREATE TABLE tafsir (
  verse_key TEXT NOT NULL REFERENCES ayah(verse_key),
  pack_id TEXT NOT NULL REFERENCES content_pack(id),
  text TEXT NOT NULL,
  covers_verse_keys TEXT NOT NULL,
  PRIMARY KEY (verse_key, pack_id)
);

CREATE TABLE similar_ayah (
  verse_key_a TEXT NOT NULL,
  verse_key_b TEXT NOT NULL,
  text_score REAL NOT NULL,
  shared_phrase TEXT,
  differing_words TEXT,
  produced_by TEXT NOT NULL,
  PRIMARY KEY (verse_key_a, verse_key_b, produced_by)
);

CREATE TABLE ayah_relation (
  from_verse_key TEXT NOT NULL,
  to_verse_key TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('explicit','textual','linguistic','thematic','educational','editorial')),
  reason TEXT NOT NULL,
  score REAL NOT NULL,
  produced_by TEXT NOT NULL,
  PRIMARY KEY (from_verse_key, to_verse_key, type, produced_by)
);

CREATE TABLE concept (
  id TEXT PRIMARY KEY,
  label_arabic TEXT NOT NULL,
  label_fa TEXT NOT NULL,
  label_en TEXT NOT NULL,
  description_fa TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('explicit','textual','linguistic','thematic','educational','editorial')),
  produced_by TEXT NOT NULL
);

CREATE TABLE concept_ayah (
  concept_id TEXT NOT NULL REFERENCES concept(id),
  verse_key TEXT NOT NULL REFERENCES ayah(verse_key),
  type TEXT NOT NULL CHECK (type IN ('explicit','textual','linguistic','thematic','educational','editorial')),
  reason TEXT NOT NULL,
  PRIMARY KEY (concept_id, verse_key, type)
);

CREATE TABLE concept_relation (
  from_concept_id TEXT NOT NULL REFERENCES concept(id),
  to_concept_id TEXT NOT NULL REFERENCES concept(id),
  type TEXT NOT NULL CHECK (type IN ('parent','child','related','contrast')),
  note TEXT NOT NULL,
  PRIMARY KEY (from_concept_id, to_concept_id, type)
);

CREATE TABLE audio_track (
  id TEXT PRIMARY KEY,
  verse_key TEXT REFERENCES ayah(verse_key),
  chapter INTEGER,
  reciter TEXT NOT NULL,
  file_path TEXT NOT NULL,
  duration_ms INTEGER,
  license_status TEXT NOT NULL CHECK (license_status IN ('clear','attribution-required','unresolved'))
);

-- ------------------------------------------------------------- user data

CREATE TABLE user_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT NOT NULL DEFAULT '',
  preferred_language TEXT NOT NULL DEFAULT 'fa',
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE bookmark (
  id TEXT PRIMARY KEY,
  verse_key TEXT REFERENCES ayah(verse_key),
  page INTEGER,
  label TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE note (
  id TEXT PRIMARY KEY,
  verse_key TEXT NOT NULL REFERENCES ayah(verse_key),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE reading_position (
  id TEXT PRIMARY KEY,
  verse_key TEXT NOT NULL REFERENCES ayah(verse_key),
  page INTEGER NOT NULL,
  scroll_fraction REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE reading_history (
  id TEXT PRIMARY KEY,
  verse_key TEXT NOT NULL REFERENCES ayah(verse_key),
  read_at TEXT NOT NULL,
  duration_ms INTEGER
);

CREATE TABLE hifz_item (
  id TEXT PRIMARY KEY,
  verse_key TEXT NOT NULL REFERENCES ayah(verse_key),
  sequence TEXT NOT NULL,
  added_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','graduated','dropped')),
  band TEXT NOT NULL CHECK (band IN ('new','unstable','weak','stable','mastered')),
  stability REAL NOT NULL DEFAULT 0,
  strength REAL NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  next_review_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX hifz_due_idx ON hifz_item(status, next_review_at);

CREATE TABLE hifz_segment (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES hifz_item(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  from_word INTEGER NOT NULL,
  to_word INTEGER NOT NULL,
  text TEXT NOT NULL,
  meaning_fa TEXT,
  meaning_source TEXT,
  stability REAL NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (item_id, position)
);

CREATE TABLE anchor_word (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES hifz_item(id) ON DELETE CASCADE,
  word_position INTEGER NOT NULL,
  text TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('opening','middle','ending','boundary')),
  stability REAL NOT NULL DEFAULT 0,
  UNIQUE (item_id, word_position, role)
);

CREATE TABLE hifz_transition (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES hifz_item(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('intra','inter')),
  to_verse_key TEXT,
  to_word INTEGER NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  stability REAL NOT NULL DEFAULT 0,
  last_practiced_at TEXT,
  UNIQUE (item_id, kind, to_word, to_verse_key)
);

CREATE TABLE hifz_attempt (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES hifz_item(id) ON DELETE CASCADE,
  verse_key TEXT NOT NULL,
  session_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('segment','opening','middle','ending','transition','continue-ayah','continue-sequence','missing-word','first-word-cue','last-word-cue','reverse','random','audio-recall','full-ayah','full-sequence')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  produced TEXT NOT NULL,
  cue TEXT,
  expected_word_count INTEGER NOT NULL,
  correct_word_count INTEGER NOT NULL,
  accuracy REAL NOT NULL,
  errors TEXT NOT NULL,
  duration_ms INTEGER,
  self_confidence INTEGER,
  used_audio INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX attempt_item_idx ON hifz_attempt(item_id, started_at);

CREATE TABLE confusion_group (
  id TEXT PRIMARY KEY,
  label TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('user','engine')),
  created_at TEXT NOT NULL,
  last_triggered_at TEXT,
  confusion_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE confusion_group_item (
  group_id TEXT NOT NULL REFERENCES confusion_group(id) ON DELETE CASCADE,
  verse_key TEXT NOT NULL REFERENCES ayah(verse_key),
  position INTEGER NOT NULL,
  PRIMARY KEY (group_id, verse_key)
);

CREATE TABLE hifz_session (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  planned_steps INTEGER NOT NULL DEFAULT 0,
  steps TEXT NOT NULL,
  report TEXT
);

CREATE TABLE learning_journey (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  goal_verse_keys TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE journey_progress (
  journey_id TEXT NOT NULL REFERENCES learning_journey(id) ON DELETE CASCADE,
  verse_key TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (journey_id, verse_key)
);

CREATE TABLE daily_plan (
  date TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  generated_at TEXT NOT NULL
);

CREATE TABLE reflection (
  id TEXT PRIMARY KEY,
  verse_key TEXT REFERENCES ayah(verse_key),
  body TEXT NOT NULL,
  written_at TEXT NOT NULL
);

-- ----------------------------------------------------------------- search

CREATE VIRTUAL TABLE ayah_search USING fts5(
  verse_key UNINDEXED,
  arabic,
  translation_en,
  translation_fa,
  tokenize = 'unicode61 remove_diacritics 2'
);
