/**
 * Hifz engine tunables.
 *
 * Every number the memory engine uses as a rule lives here as a named,
 * documented constant. Nothing in `core/src/hifz/**` may hard-code a
 * threshold inline. This is what makes the engine tunable without a rewrite.
 *
 * IMPORTANT: the weightings below are engineering heuristics. They were picked
 * to be monotone, bounded and explainable. They are NOT validated by memory
 * research, and no claim of scientific validity is made anywhere in this
 * engine or its docs.
 */

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

import type { RecallMode } from '../contracts/hifz';

/** Seconds-per-hour helpers for interval arithmetic (no clock reads). */
export const MS_PER_DAY = 86_400_000;

/** Decimal places every emitted score is rounded to (stable serialisation). */
export const SCORE_DECIMALS = 4;

/* ------------------------------------------------------------------ *
 * Segmentation (segment.ts) — see docs/memory-fingerprint.md
 * ------------------------------------------------------------------ */

/**
 * Ornamental tokens that mark a pause (waqf) or a division inside an ayah.
 * A raw whitespace token is treated as a mark when it normalises to the empty
 * string, or when it consists only of characters in this set. Mirrors the
 * filtering that `tokenizeWords` already performs; kept here so the rule set
 * is explicit and testable.
 */
export const WAQF_MARK_CHARS = '۞۩ۜۚۙۘۗۖ۔ۓ۔ۗۚۛۜ۝ٰ';

/** Shortest segment the segmenter may produce (in words). */
export const MIN_SEGMENT_WORDS = 2;

/**
 * Longest segment the segmenter may produce (in words). A span longer than
 * this forces a split, which is how long ayahs (2:255) still get segmented.
 */
export const MAX_SEGMENT_WORDS = 6;

/**
 * Particles whose standalone form begins a new clause. Compared against the
 * NORMALISED token, so hamza carriers are already folded to `ا`
 * (`إن`/`أن` → `ان`, `إلى` → `الي`, `على` → `علي`, `إذا` → `اذا`).
 */
export const STANDALONE_CONNECTORS: readonly string[] = [
  'و', // و
  'ف', // ف
  'ثم', // ثم
  'ان', // أن / إن
  'لو', // لو
  'ما', // ما
  'من', // من
  'الي', // إلى
  'علي', // على
  'في', // في
  'حيث', // حيث
  'كما', // كما
  'اذا', // إذا
];

/**
 * Prefix clitics that may be joined to the following word with no space and
 * still start a clause. Only `و` and `fāʾ` are treated as joinable prefixes,
 * because longer particles are almost always written as separate tokens.
 * Words whose *root* begins with these letters are a known, documented
 * false-positive class (e.g. `وَسِعَ`); the pause mark usually fires there
 * anyway, and the min/max segment constraints absorb the rest.
 */
export const PREFIX_CONNECTORS: readonly string[] = ['و', 'ف', 'ثم'];

/** Minimum remainder after a prefix clitic for it to count as a connector. */
export const MIN_PREFIX_REMAINDER_CHARS = 2;

/** Boundary score contributed by a pause/ornament mark before the word. */
export const BOUNDARY_SCORE_PAUSE = 3;

/** Boundary score contributed by a clause-initial connector. */
export const BOUNDARY_SCORE_CONNECTOR = 2;

/** A forced midpoint split (used only to honour MAX_SEGMENT_WORDS). */
export const BOUNDARY_SCORE_FORCED = 0;

/** Window (in words) around the midpoint where a forced split prefers a real candidate. */
export const FORCED_SPLIT_CANDIDATE_WINDOW = 2;

/** Stability a freshly created segment/anchor/transition carries (no data yet). */
export const FRESH_MEMORY_STABILITY = 0;

/** Initial segment id prefix helper: `itemId:verseKey:s{position}`. */
export const SEGMENT_ID_TAG = 's';
export const ANCHOR_ID_TAG = 'a';
export const TRANSITION_ID_TAG = 't';

/* ------------------------------------------------------------------ *
 * Recall probes (recall.ts)
 * ------------------------------------------------------------------ */

/** How many words of cue a transition probe shows before the boundary. */
export const TRANSITION_CUE_WORDS = 2;

/** How many words a transition probe expects after the boundary. */
export const TRANSITION_EXPECTED_WORDS = 3;

/** Words shown as cue in a continue-sequence probe (previous ayah's ending). */
export const SEQUENCE_CUE_WORDS = 2;

/** Words expected in a continue-sequence probe (next ayah's opening). */
export const SEQUENCE_EXPECTED_WORDS = 4;

/** Span length a random probe tries to cover. */
export const RANDOM_PROBE_SPAN_WORDS = 3;

/** Cue span length for opening/middle/ending probes (a third of the ayah). */
export const POSITIONAL_THIRDS = 3;

/** Placeholder rendered where a missing-word probe blanks a word. */
export const MISSING_WORD_PLACEHOLDER = '⟪……⟫';

/* ---- meaning-axis probes (recall.ts) ---- */

/**
 * How many opening words a `concept-cue` probe expects: the learner hears the
 * meaning of the previous ayah and must produce how the next one starts. Shorter
 * than a full ayah on purpose — the chain link is what is being trained.
 */
export const CONCEPT_CUE_EXPECTED_WORDS = 4;

/**
 * Content pack the per-word English glosses ship in (`ayah_word.translation_en`).
 * Only used as the default `packId` label when a caller asks the segmenter to join
 * word glosses; the caller always decides the language. No engine code reads a
 * database with this id — it is a label the caller's own source carries.
 */
export const WORD_GLOSS_PACK_ID = 'word-data';

/** Language a joined word-gloss chunk is written in (`ayah_word.translation_en`). */
export const WORD_GLOSS_LANG = 'en';

/* ------------------------------------------------------------------ *
 * Classification (classify.ts) — see docs/hifz-engine.md
 * ------------------------------------------------------------------ */

/** Alignment cost of producing the expected word. */
export const ALIGN_MATCH_COST = 0;

/** Alignment cost of a same-length wrong word. */
export const ALIGN_MISMATCH_COST = 2;

/** Cost charged for opening a gap (omission or insertion run). */
export const ALIGN_GAP_OPEN_COST = 3;

/** Cost charged for every extra word in an already-open gap. */
export const ALIGN_GAP_EXTEND_COST = 1;

/**
 * A wrong word that is this similar (1 - editDistance/len) to the expected
 * word is reported as a "near miss" in the explanation, but it is still a
 * substitution: correctness is exact-normalised-equality only.
 */
export const NEAR_MISS_SIMILARITY = 0.7;

/** Minimum run length (words) for a continuation to be attributed to another ayah. */
export const CONTINUATION_MIN_WORDS = 2;

/** tokenSimilarity needed to say "this run is really another ayah's words". */
export const WRONG_TRANSITION_SIMILARITY = 0.6;

/** setSimilarity needed to say "this recitation is a confusion candidate's". */
export const CONFUSION_SIMILARITY = 0.55;

/** tokenSimilarity between a produced run and a candidate run. */
export const RUN_SIMILARITY = 0.6;

/**
 * Modes whose probe covered the whole ayah, so a positional
 * beginning/middle/ending failure is meaningful for them.
 */
export const POSITIONAL_FAILURE_MODES: readonly string[] = [
  'full-ayah',
  'full-sequence',
  'continue-ayah',
  'reverse',
  'audio-recall',
];

/* ------------------------------------------------------------------ *
 * Stability (stability.ts) — see docs/review-algorithm.md
 * ------------------------------------------------------------------ */

/** Attempts considered "recent", newest first. */
export const RECENT_WINDOW = 5;

/** Per-older-attempt weight multiplier inside the recent window. */
export const RECENCY_WEIGHT_DECAY = 0.7;

/** Composite strength components; must sum to 1. */
export const W_RECENT_ACCURACY = 0.55;
export const W_CONSISTENCY = 0.15;
export const W_ATTEMPT_COUNT = 0.15;
export const W_ERROR_RATE = 0.15;

/** Half-life of memory in days: after 14 days untouched, decay factor is 0.5. */
export const DECAY_HALF_LIFE_DAYS = 14;

/** Decay never falls below this floor (a learned ayah is never fully lost). */
export const DECAY_FLOOR = 0.05;

/** Attempts at which the attempt-count component saturates. */
export const ATTEMPT_SATURATION = 5;

/** An attempt with this accuracy counts as a success everywhere in the engine. */
export const SUCCESS_ACCURACY = 0.85;

/** Bands: `new` while there are fewer attempts than this. */
export const NEW_MAX_ATTEMPTS = 2;

/** Mastered requires all four at once. */
export const MASTERED_MIN_STABILITY = 0.92;
export const MASTERED_MIN_ATTEMPTS = 8;
export const MASTERED_MIN_RECENT_ACCURACY = 0.95;
export const MASTERED_MAX_ERROR_RATE = 0.03;

/** Band floors on stability. */
export const STABLE_MIN_STABILITY = 0.75;
export const WEAK_MIN_STABILITY = 0.45;

/**
 * Attempt floors: two lucky recitations do not make an ayah `stable`.
 * `stable` needs `STABLE_MIN_ATTEMPTS`, `weak` needs `WEAK_MIN_ATTEMPTS`.
 */
export const STABLE_MIN_ATTEMPTS = 3;
export const WEAK_MIN_ATTEMPTS = 2;

/** Review interval in days per band, before the stability multiplier. */
export const BAND_INTERVAL_DAYS: Readonly<Record<string, number>> = {
  new: 0,
  unstable: 1,
  weak: 2,
  stable: 5,
  mastered: 12,
};

/**
 * Interval multiplier from stability: `0.5 + STABILITY_INTERVAL_GAIN * stability`.
 * A stable-but-shallow item still gets pulled back to half the band interval.
 */
export const STABILITY_INTERVAL_GAIN = 1.0;

/** Longest interval the engine will ever schedule (days). */
export const MAX_INTERVAL_DAYS = 45;

/* ------------------------------------------------------------------ *
 * Dual-axis stability (stability.ts) — form vs meaning
 * ------------------------------------------------------------------ */

/**
 * EWMA rate an item's axis stability moves toward the accuracy of a graded
 * attempt on that axis. Engineering heuristic, chosen bounded and monotone like
 * every other number in this file; NOT validated by memory research.
 */
export const AXIS_LEARN_RATE = 0.3;

/**
 * Value an axis is measured from before its first attempt. Zero: an axis nobody
 * has tested is not "half memorised", it is untested. The item-level composite
 * only reads the meaning axis at all when a licensed meaning exists to test it
 * (see `computeStabilityByAxis`).
 */
export const AXIS_UNTESTED_STABILITY = 0;

/**
 * A segment's `meaningStability` is null (never "0") until a meaning attempt
 * lands, so a report can tell "no data" apart from "tested and failed". This is
 * the base the first meaning attempt's EWMA is measured against.
 */
export const SEGMENT_MEANING_BASE = AXIS_UNTESTED_STABILITY;

/* ------------------------------------------------------------------ *
 * Review scheduling (review.ts) — see docs/review-algorithm.md
 * ------------------------------------------------------------------ */

/**
 * Review priority weights. The nine original factors sum to exactly 1.00 and
 * their values are the ones documented in `docs/review-algorithm.md`: an item
 * with no meaning lag must score the same today as it scored before the meaning
 * axis existed, so adding a tenth factor may not move the other nine.
 *
 * `meaning-gap` is applied as a bounded **uplift** on the headroom the nine left
 * (`gap × 0.12 × (1 − priority)`), not as a slice taken out of them: it can only
 * raise an item's urgency, the total stays inside 0..1 without clamping, and no
 * documented factor is silently re-weighted.
 */
export const REVIEW_WEIGHTS = {
  'historical-errors': 0.16,
  'weak-segments': 0.16,
  'weak-transitions': 0.12,
  overdue: 0.2,
  'recency-of-success': 0.08,
  repetition: 0.08,
  'confusion-rate': 0.1,
  'group-membership': 0.06,
  band: 0.04,
  /** How far the meaning axis lags behind the form axis. 0 when no licensed
   * meaning exists for the item, because an untestable axis is not a gap. */
  'meaning-gap': 0.12,
} as const;

export type ReviewFactorKey = keyof typeof REVIEW_WEIGHTS;

/** Days of lateness at which the overdue factor saturates. */
export const OVERDUE_SATURATION_DAYS = 21;

/** Factor used when an item has never been scheduled (nextReviewAt = null). */
export const NEVER_SCHEDULED_FACTOR = 0.4;

/** Days since the last successful recall at which the staleness factor saturates. */
export const RECENCY_SATURATION_DAYS = 30;

/** Attempts at which the repetition factor saturates. */
export const REPETITION_SATURATION_ATTEMPTS = 12;

/** Segments below this stability count as weak. */
export const WEAK_SEGMENT_STABILITY = 0.6;

/** Transitions below this stability count as weak. */
export const WEAK_TRANSITION_STABILITY = 0.6;

/**
 * Form-minus-meaning lag at which the `meaning-gap` factor saturates. Below it
 * the factor scales linearly, so a small lag nudges a review instead of
 * hijacking the queue.
 */
export const MEANING_GAP_SATURATION = 0.6;

/**
 * Lag the scheduler assumes for an item a licensed meaning covers but whose
 * meaning axis has never been probed (`meaningStability` is null). It saturates
 * the factor by design: a whole axis nobody has tested yet is the biggest
 * possible gap in understanding, and it is the reason meaning drills appear at
 * all. An item with no licensed meaning gets a gap of 0 instead — nothing to
 * test is not a failure to know.
 */
export const MEANING_UNTESTED_GAP = 1;

/**
 * Lag at or below which the scheduler prefers `concept-cue` over
 * `meaning-to-arabic` when the previous ayah also has a licensed meaning: a
 * nearly-caught-up axis is trained as a chain, a badly lagging one is trained
 * as a direct meaning→Arabic binding first.
 */
export const MEANING_CONCEPT_CUE_MAX_GAP = 0.5;

/** Confusion-type errors at which the confusion factor saturates. */
export const CONFUSION_SATURATION_ERRORS = 3;

/** Errors per ayah used to normalise historical errors when word counts are missing. */
export const HISTORICAL_ERROR_WORD_NORMALIZER = 24;

/** Band urgency mapped into the `band` factor (0..1). */
export const BAND_URGENCY: Readonly<Record<string, number>> = {
  new: 0.75,
  unstable: 1,
  weak: 0.8,
  stable: 0.4,
  mastered: 0.1,
};

/** Items a day the plan will hold, excluding new ayahs. */
export const DAILY_REVIEW_ITEM_CAP = 20;

/** New ayahs introduced per day. */
export const NEW_AYAH_PER_DAY_CAP = 5;

/** Priority at or above which an entry is classified as a weak item. */
export const PRIORITY_WEAK_CUTOFF = 0.55;

/** Entries below this priority are not put in the daily plan at all. */
export const PRIORITY_PLAN_CUTOFF = 0.18;

/** Confusion triggers at which the group-membership factor saturates. */
export const GROUP_CONFUSION_SATURATION = 3;

/** Extra priority a grouped ayah gets when its group is triggered. */
export const GROUP_BOOST_PER_TRIGGER = 0.02;

/** Ceiling on the group boost. */
export const GROUP_BOOST_CAP = 0.08;

/** Group members are pulled to within this of the boosted group leader. */
export const GROUP_MEMBER_TAPER = 0.05;

/**
 * Ceiling on how far a member may be pulled toward its leader. Without it a
 * `mastered` partner of a `weak` ayah would be dragged across the whole
 * priority range, which is not what "review the pair together" means.
 */
export const GROUP_MEMBER_LIFT_CAP = 0.15;

/* ------------------------------------------------------------------ *
 * Confusion groups (confusion.ts)
 * ------------------------------------------------------------------ */

/** Cross-ayah substitutions needed before the engine proposes a group. */
export const PROPOSE_MIN_TRIGGERS = 2;

/* ------------------------------------------------------------------ *
 * Cost model (review.ts / session.ts) — seconds
 * ------------------------------------------------------------------ */

/**
 * Per-attempt cost by recall mode. Deliberately explicit so
 * `DailyPlan.estimatedMinutes` is a sum of real steps, never a constant.
 *
 * Keyed by `RecallMode`, not by `string`: a mode the scheduler can pick but this
 * table cannot price would silently cost nothing, and the compiler is the only
 * reviewer that never forgets to check.
 */
export const MODE_COST_SECONDS: Readonly<Record<RecallMode, number>> = {
  segment: 12,
  opening: 10,
  middle: 10,
  ending: 10,
  transition: 8,
  'continue-ayah': 20,
  'continue-sequence': 20,
  'missing-word': 8,
  'first-word-cue': 15,
  'last-word-cue': 15,
  reverse: 25,
  random: 20,
  'audio-recall': 35,
  'full-ayah': 30,
  'full-sequence': 45,
  // Priced like the form probe of the same span: the reading of the cue is
  // cheap, producing the Arabic is what takes the time.
  'meaning-to-arabic': 30,
  'concept-cue': 18,
};

/** Cost of the first exposure to a new ayah (listen + read + imitate). */
export const NEW_AYAH_EXPOSURE_SECONDS = 90;

/** Extra seconds per word when memorising a new ayah (chunk building). */
export const NEW_AYAH_PER_WORD_SECONDS = 6;

/** Per-attempt cost of a new-ayah learning step. */
export const NEW_LEARNING_ATTEMPT_SECONDS = 40;

/** Recall attempts made while learning a brand-new ayah. */
export const NEW_LEARNING_RECALL_ATTEMPTS = 2;

/** Words assumed for a new ayah when its word count is not supplied. */
export const DEFAULT_NEW_AYAH_WORD_COUNT = 6;

/** Seconds of instruction/transition overhead between session steps. */
export const STEP_OVERHEAD_SECONDS = 5;

/** Assessment step cost, on top of the mode cost of the step itself. */
export const ASSESSMENT_STEP_SECONDS = 25;

/**
 * Session phases and the modes they use, in order (session.ts). The two meaning
 * phases only emit steps when a licensed meaning actually covers the ayah — with
 * no meaning data installed the session builds exactly the steps it built before
 * the meaning axis existed.
 */
export const SESSION_PHASES: readonly string[] = [
  'warm-up',
  'meaning-introduction',
  'new-learning',
  'progressive-recall',
  'meaning-drill',
  'transition-training',
  'similar-ayah-drill',
  'reverse',
  'random',
  'assessment',
];

/** Meaning drills touch at most this many items per session. */
export const MEANING_DRILL_ITEM_CAP = 4;

/**
 * Smallest form-minus-meaning lag that earns one of those scarce slots.
 *
 * A lag below this is not distinguishable from measurement noise: one graded
 * attempt moves an axis by at most `AXIS_LEARN_RATE` of the remaining distance,
 * so a 0.05 gap is well inside what a single recitation could produce by
 * accident. Drilling it would spend session time on a difference the engine
 * cannot honestly claim exists. The scheduler still *reports* such a lag — this
 * gates session slots, not the priority factor.
 */
export const MEANING_DRILL_MIN_LAG = 0.1;

/** EWMA rate for transition/segment stability updates from a single attempt. */
export const LEARN_RATE = 0.35;

/** A kind counted this many times in a session is a "repeated error". */
export const REPEATED_ERROR_MIN_COUNT = 2;

/** Warm-up picks this many of the most recently reviewed items. */
export const WARM_UP_ITEM_COUNT = 2;

/** Drills include at most this many steps per phase. */
export const PHASE_STEP_CAP = 4;

/** Reverse/random drills touch at most this many items per session. */
export const PROBE_DRILL_ITEM_CAP = 3;
