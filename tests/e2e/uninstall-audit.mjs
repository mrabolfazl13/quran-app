/**
 * tests/e2e/uninstall-audit.mjs — what actually survives `uninstall.exe /S`.
 *
 * docs/packaging.md promises an offline product with a database the user owns.
 * Whether the uninstaller eats that database, leaves the WebView2 cache behind,
 * or half-removes the install directory is a fact about the shipped installer,
 * not something to reason about from the NSIS template. So this script measures
 * it, in this order:
 *
 *  1. copy every directory the app owns into %TEMP% (a copy, never a park: the
 *     audit has to watch the uninstaller touch the real paths or it proves
 *     nothing);
 *  2. snapshot the filesystem tree, the HKCU uninstall key, and the Start Menu /
 *     desktop shortcuts;
 *  3. run `uninstall.exe /S` and wait for it to finish;
 *  4. re-snapshot and print the exact diff — removed, survived, changed;
 *  5. with `--reinstall`, run the installer silently and re-check the install
 *     directory, then put the copied user data back byte for byte.
 *
 * It refuses to run while a quran-desktop.exe is alive, and it never deletes the
 * copy it made until `--discard-backup` says so.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IDENTIFIER, PRODUCT_NAME, installDir } from './lib/launch.mjs';

const args = new Set(process.argv.slice(2));
const KEEP_COPY = !args.has('--discard-backup');
const REINSTALL = args.has('--reinstall');
const INSTALLER =
  process.argv
    .slice(2)
    .find((a) => a.startsWith('--installer='))
    ?.slice('--installer='.length) ?? null;

function sh(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', shell: true });
  return { status: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

/** Deterministic tree snapshot: relative path → size + content hash for small files. */
function snapshot(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return { missing: true, entries: new Map() };
  const entries = new Map();
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        entries.set(path.relative(abs, full), { error: 'unreadable' });
        continue;
      }
      if (stat.isDirectory()) {
        entries.set(path.relative(abs, full), { dir: true });
        walk(full);
      } else {
        const small = stat.size <= 8 * 1024 * 1024;
        entries.set(path.relative(abs, full), {
          bytes: stat.size,
          digest: small ? createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16) : null,
        });
      }
    }
  };
  walk(abs);
  return { missing: false, entries };
}

function registryState() {
  const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${IDENTIFIER}`;
  const r = sh('reg', ['query', `"${key}"`]);
  const shortcuts = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT_NAME}.lnk`),
    path.join(os.homedir(), 'Desktop', `${PRODUCT_NAME}.lnk`),
  ].filter((p) => p && fs.existsSync(p));
  return { keyPresent: r.status === 0, key, shortcuts };
}

function diff(before, after, label) {
  const removed = [];
  const survived = [];
  const changed = [];
  const added = [];
  for (const [rel, value] of before.entries) {
    const now = after.entries.get(rel);
    if (!now) removed.push(rel);
    else if (JSON.stringify(now) !== JSON.stringify(value)) changed.push(rel);
    else survived.push(rel);
  }
  for (const rel of after.entries.keys()) if (!before.entries.has(rel)) added.push(rel);
  const shown = (list) => list.slice(0, 12).join(', ') + (list.length > 12 ? ` … (+${list.length - 12})` : '');
  console.log(
    `\n[${label}] before ${before.entries.size} paths → after ${after.entries.size}: ` +
      `${removed.length} removed, ${survived.length} survived, ${changed.length} changed, ${added.length} added`,
  );
  for (const [word, list] of [
    ['removed', removed],
    ['survived', survived],
    ['changed', changed],
    ['added', added],
  ]) {
    if (list.length) console.log(`  ${word}: ${shown(list)}`);
  }
  return { removed, survived, changed, added };
}

function appRunning() {
  const r = sh('powershell', [
    '-NoProfile',
    '-Command',
    '"if (Get-CimInstance Win32_Process -Filter \\"Name=\'quran-desktop.exe\'\\") {echo yes} else {echo no}"',
  ]);
  return /yes/.test(r.out);
}

function waitForExit(exeName, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = sh('powershell', [
      '-NoProfile',
      '-Command',
      `"if (Get-CimInstance Win32_Process -Filter \\"Name='${exeName}'\\") {echo running} else {echo gone}"`,
    ]);
    if (/gone/.test(r.out)) return true;
    spawnSync('ping', ['-n', '2', '127.0.0.1'], { stdio: 'ignore' });
  }
  return false;
}

function copyTree(src, dest) {
  if (!fs.existsSync(src)) return null;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const backupRoot = path.join(os.tmpdir(), `quran-uninstall-audit-${STAMP}`);

const dirs = {
  // The SQLite database and the .quranbak files — the user's own data.
  roamingData: path.join(process.env.APPDATA || '', IDENTIFIER),
  // WebView2's profile (EBWebView) — cache, local storage, cookies.
  webViewData: path.join(process.env.LOCALAPPDATA || '', IDENTIFIER),
  // The installed program itself.
  install: installDir(),
};

console.log(`uninstall audit ${STAMP}`);
for (const [name, dir] of Object.entries(dirs)) {
  console.log(`  ${name.padEnd(12)} ${dir} ${fs.existsSync(dir) ? '' : '(absent)'}`);
}

if (appRunning()) {
  console.error('\nREFUSED: a quran-desktop.exe is running. Close it first — this script never kills a process it did not start.');
  process.exit(2);
}

// 1 + 2: copy, then snapshot.
fs.mkdirSync(backupRoot, { recursive: true });
const copies = {};
for (const [name, dir] of Object.entries(dirs)) {
  if (fs.existsSync(dir)) copies[name] = copyTree(dir, path.join(backupRoot, 'copy', name));
}
console.log(`\ncopied to ${backupRoot}${copies.roamingData ? '' : ' (no roaming data to copy)'}`);

const before = {
  roamingData: snapshot(dirs.roamingData),
  webViewData: snapshot(dirs.webViewData),
  install: snapshot(dirs.install),
  registry: registryState(),
};
console.log(
  `before uninstall: install ${before.install.entries.size} paths, roaming ${before.roamingData.entries.size}, ` +
    `webview ${before.webViewData.entries.size}, uninstall key ${before.registry.keyPresent}, ` +
    `shortcuts ${before.registry.shortcuts.length}`,
);

// 3: run the uninstaller silently.
const uninstaller = path.join(dirs.install, 'uninstall.exe');
if (!fs.existsSync(uninstaller)) {
  console.error(`\nFAIL: ${uninstaller} is not there — is the app installed at all?`);
  process.exit(1);
}
console.log(`\nrunning ${uninstaller} /S`);
const child = spawnSync(uninstaller, ['/S', '/NCRC'], { shell: true });
const exited = waitForExit('uninstall.exe', 180_000);
console.log(`uninstaller exit status ${child.status}; process ${exited ? 'finished' : 'STILL RUNNING after 180 s'}`);

// 4: re-snapshot and diff.
const after = {
  roamingData: snapshot(dirs.roamingData),
  webViewData: snapshot(dirs.webViewData),
  install: snapshot(dirs.install),
  registry: registryState(),
};
const report = {
  roamingData: diff(before.roamingData, after.roamingData, 'user database + backups'),
  webViewData: diff(before.webViewData, after.webViewData, 'WebView2 profile'),
  install: diff(before.install, after.install, 'install directory'),
};
console.log(
  `registry key ${before.registry.keyPresent ? 'present' : 'absent'} → ${after.registry.keyPresent ? 'present' : 'absent'}; ` +
    `shortcuts ${before.registry.shortcuts.length} → ${after.registry.shortcuts.length}`,
);

// 5: put the machine back the way it was found.
let restored = null;
if (REINSTALL) {
  if (!INSTALLER || !fs.existsSync(INSTALLER)) {
    console.error(`\n--reinstall needs --installer=<path to setup .exe>${INSTALLER ? ` (${INSTALLER} missing)` : ''}`);
  } else {
    console.log(`\ninstalling ${INSTALLER} /S`);
    spawnSync(INSTALLER, ['/S'], { shell: true });
    waitForExit(path.basename(INSTALLER), 240_000);
    const back = snapshot(dirs.install);
    console.log(`after reinstall: install directory has ${back.entries.size} paths (was ${before.install.entries.size})`);
    report.reinstall = { before: before.install.entries.size, after: back.entries.size, exeBack: fs.existsSync(path.join(dirs.install, 'quran-desktop.exe')) };
  }
}
// User data always goes back: the audit is about the uninstaller, not about
// losing anything.
const restoreLog = [];
for (const [name, dir] of Object.entries(dirs)) {
  if (!copies[name]) continue;
  if (name === 'install') continue; // rebuilt by --reinstall, not pasted back
  if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) {
    fs.cpSync(copies[name], dir, { recursive: true });
    restoreLog.push(`${name} → ${dir}`);
  } else {
    restoreLog.push(`${name}: left in place (directory not empty after the audit)`);
  }
}
console.log(`\nrestored user data: ${restoreLog.join(' | ') || 'nothing to restore'}`);
const recheck = snapshot(dirs.roamingData);
const original = snapshot(copies.roamingData || dirs.roamingData);
const same =
  !copies.roamingData ||
  [...original.entries].every(([rel, v]) => JSON.stringify(recheck.entries.get(rel)) === JSON.stringify(v));
console.log(`roaming data byte-identical to the copy: ${same}`);
if (KEEP_COPY) console.log(`backup kept at ${backupRoot}\\copy (remove by hand once the numbers are in the docs)`);

fs.writeFileSync(path.join(backupRoot, 'audit.json'), JSON.stringify({ dirs, report, registry: { before: before.registry, after: after.registry } }, null, 2));
console.log(`wrote ${path.join(backupRoot, 'audit.json')}`);
process.exitCode = same ? 0 : 1;
