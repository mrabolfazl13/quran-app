/**
 * tests/e2e/lib/profile.mjs — a genuinely fresh app-data directory, reversibly.
 *
 * The honest problem: a Tauri app's data directory is *not* an environment
 * variable. `app_data_dir()` resolves the Windows `FOLDERID_RoamingAppData` known
 * folder, so `%APPDATA%\app.quran.platform` is where `quran.db` goes no matter
 * what the child process' environment says. WebView2's `--user-data-dir` is
 * reliable and does redirect the browser profile (localStorage, cache), but it
 * has no effect on the SQLite file.
 *
 * What this module therefore does, in order, and reports which part worked:
 *  1. sets `APPDATA` for the child to a unique directory this run created — if
 *     the binary honours it, the fresh directory is literal and nothing is moved;
 *  2. parks (`rename`s aside, never deletes) a pre-existing
 *     `%APPDATA%\app.quran.platform` so the canonical path is empty and the app
 *     really does run its first-launch path;
 *  3. writes a journal BEFORE touching anything, so a crashed run can be undone;
 *  4. at the end deletes only the directory the app created during this run, and
 *     renames the parked profile back.
 *
 * Nothing pre-existing is ever deleted: `parkedTo` is a rename target owned by
 * this run, and the delete branch checks that the directory did not exist before
 * the run and that it is one of the two paths this module handed out.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { IDENTIFIER } from './launch.mjs';

export function roamingAppDataRoot() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, IDENTIFIER);
}

export function journalPath() {
  return path.join(os.tmpdir(), 'quran-e2e-park-journal.json');
}

/** Sync wait: `finish()` is called on the way out of the process, with no loop left to await. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Delete a directory that a WebView2 process may still be holding open, giving
 * up only after the runtime has had time to notice its host died. Throws the
 * last error the filesystem gave, so the caller's warning carries a real reason.
 */
function removeWithPatience(target, { attempts = 40, waitMs = 300 } = {}) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      last = error;
      if (!existsSync(target)) return;
      sleepSync(waitMs);
    }
  }
  throw last ?? new Error('could not remove the directory');
}

export class ProfileGuard {
  /**
   * @param {{runRoot: string, mode: 'fresh'|'as-is', identifier?: string}} options
   */
  constructor({ runRoot, mode = 'fresh', identifier = IDENTIFIER }) {
    this.runRoot = runRoot;
    this.mode = mode;
    this.identifier = identifier;
    this.canonical = roamingAppDataRoot();
    /** Directory handed to the child as %APPDATA% — honoured or not, we measure it. */
    this.freshAppData = path.join(runRoot, 'appdata', identifier);
    this.parkedTo = null;
    this.journal = null;
    this.freshEnvHonoured = null;
    mkdirSync(this.freshAppData, { recursive: true });
  }

  static readJournal() {
    const file = journalPath();
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return { unreadable: file };
    }
  }

  static clearJournal() {
    rmSync(journalPath(), { force: true });
  }

  /**
   * Undo a park left behind by a run that did not finish. Refuses to do anything
   * while an app instance could still be holding the directory.
   */
  static restoreFromJournal({ appRunning }) {
    const entry = ProfileGuard.readJournal();
    if (!entry) return null;
    if (entry.unreadable) throw new Error(`park journal at ${entry.unreadable} is unreadable — inspect it by hand before deleting`);
    if (appRunning) throw new Error(`a quran-desktop.exe is running; close it, then re-run with --restore-profile to put ${entry.parkedTo} back`);
    if (!existsSync(entry.parkedTo)) throw new Error(`journal points at ${entry.parkedTo}, which no longer exists — resolve by hand`);
    if (existsSync(entry.canonical)) {
      // The run's own directory is what occupies the canonical path: drop it only
      // when it is provably this suite's creation.
      if (!ProfileGuard.looksLikeThisRunsProfile(entry)) {
        throw new Error(`${entry.canonical} exists and is not the profile this journal says was created — resolve by hand`);
      }
      rmSync(entry.canonical, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
    renameSync(entry.parkedTo, entry.canonical);
    const restored = { ...entry };
    ProfileGuard.clearJournal();
    return restored;
  }

  static looksLikeThisRunsProfile(entry) {
    if (!entry.createdPath) return false;
    const target = entry.createdPath;
    if (!existsSync(target)) return false;
    // Either empty, or created after the journal was written.
    try {
      const stat = statSync(target);
      const entries = existsSync(path.join(target, 'quran.db')) ? ['quran.db'] : [];
      return stat.birthtimeMs >= Date.parse(entry.createdAt) - 5000 || entries.length === 0;
    } catch {
      return false;
    }
  }

  /** Park the existing profile and tell the child where its data should live. */
  prepare({ appRunning }) {
    if (ProfileGuard.readJournal()) {
      throw new Error(
        `a previous run left a park journal at ${journalPath()}.\n` +
          'Finish it with: node tests/e2e/run.mjs --restore-profile',
      );
    }
    const env = { APPDATA: path.dirname(this.freshAppData) };
    if (this.mode === 'as-is') {
      return { parked: false, env: {}, note: 'profile mode as-is: the app keeps its real profile; first-run steps are skipped' };
    }
    if (!existsSync(this.canonical)) {
      return { parked: false, env, note: `no ${this.canonical} — the machine is already fresh, nothing parked` };
    }
    if (appRunning) {
      throw new Error('a quran-desktop.exe is already running; close it before parking the profile (this suite never kills a process it did not start)');
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    this.parkedTo = `${this.canonical}.e2e-parked-${stamp}`;
    this.journal = {
      version: 1,
      createdAt: new Date().toISOString(),
      pid: process.pid,
      canonical: this.canonical,
      parkedTo: this.parkedTo,
      createdPath: this.canonical,
      freshAppData: this.freshAppData,
    };
    // The journal exists before the rename: an interrupted run is recoverable.
    writeFileSync(journalPath(), JSON.stringify(this.journal, null, 2));
    renameSync(this.canonical, this.parkedTo);
    return { parked: true, env, note: `parked ${this.canonical} → ${this.parkedTo} (nothing deleted)` };
  }

  /**
   * Called with the `appData` path the shipped binary reported for itself. Records
   * which of the two isolation mechanisms actually worked.
   */
  observeReported(reported) {
    const normalise = (p) => path.resolve(p).replace(/[\\/]$/, '').toLowerCase();
    this.reportedAppData = reported;
    this.freshEnvHonoured = normalise(reported) === normalise(this.freshAppData);
    this.createdPathIsCanonical = normalise(reported) === normalise(this.canonical);
    return { freshEnvHonoured: this.freshEnvHonoured, reported };
  }

  /**
   * Remove the profile this run created and put a parked profile back.
   * Returns a summary the report prints verbatim.
   */
  finish({ keep = false } = {}) {
    const summary = { deleted: [], restored: null, warnings: [] };
    if (!this.journal) {
      if (this.mode === 'fresh' && !existsSync(this.canonical)) summary.warnings.push('nothing to restore: the machine was already fresh');
      return summary;
    }
    if (keep) {
      summary.warnings.push(`--keep-profile: leaving ${this.reportedAppData || this.canonical} in place and NOT restoring ${this.parkedTo}`);
      return summary;
    }
    const target = this.freshEnvHonoured ? this.freshAppData : this.canonical;
    if (existsSync(target)) {
      // Only ever the path this run observed the app writing to, and only when we
      // parked a real profile away (so this path was empty before the run).
      if (!this.createdPathIsCanonical && !this.freshEnvHonoured) {
        summary.warnings.push(`refusing to delete ${target}: this run never observed the app writing there`);
      } else {
        try {
          // `taskkill /T /F` on the app does not always take the WebView2 runtime
          // with it — those processes can outlive their parent — and one open
          // handle on the SQLite file is enough to fail the delete. Retrying is
          // not busywork: the handle closes when the runtime notices its host is
          // gone, which is seconds, not minutes. A parked profile that cannot be
          // restored is the user's own data left in a temp directory, so the
          // budget here is deliberately long.
          removeWithPatience(target);
          summary.deleted.push(target);
        } catch (error) {
          summary.warnings.push(`could not delete ${target}: ${error.message} (leaving it; a WebView2 handle can outlive the process)`);
        }
      }
    }
    if (existsSync(this.parkedTo)) {
      if (existsSync(this.canonical)) {
        summary.warnings.push(
          `${this.canonical} still exists after cleanup — refusing to overwrite it. Your original profile is intact at ${this.parkedTo}; ` +
            `close the app and run \`node tests/e2e/run.mjs --restore-profile\` to put it back.`,
        );
      } else {
        renameSync(this.parkedTo, this.canonical);
        summary.restored = this.canonical;
      }
    }
    if (!summary.warnings.some((w) => /refusing|still exists/.test(w))) ProfileGuard.clearJournal();
    return summary;
  }
}

/** Directories this run owns: created under %TEMP%, deleted only if we made them. */
export function createRunRoot(prefix = 'quran-e2e') {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const root = path.join(os.tmpdir(), `${prefix}-${stamp}-${process.pid}`);
  for (const dir of ['webview', 'logs', 'shots', 'appdata']) mkdirSync(path.join(root, dir), { recursive: true });
  return { root, stamp };
}
