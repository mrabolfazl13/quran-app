/**
 * Peak-RAM measurement helpers.
 *
 * Two independent samples per run so neither one can lie:
 *  - `memwatch.ps1` runs in its own PowerShell process and polls the OS for the
 *    target PID's working set, private bytes, the kernel's `PeakWorkingSet64`
 *    and free physical RAM, tagging each sample with the current benchmark
 *    phase (read back from a tiny phase file the measured process rewrites).
 *  - in-process `process.memoryUsage()` sampling shows the JS-side share.
 *
 * The reported per-phase peak is the max of the sampled working set inside
 * that phase; the global peak is the OS-tracked high-water mark. Raw sample
 * CSVs stay under `results/` so any number can be recomputed.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');

export class MemWatch {
  /**
   * @param {string} csvPath where the watcher writes its samples
   * @param {string} phasePath file the measured process writes its phase into
   */
  constructor(csvPath, phasePath, { intervalMs = 50 } = {}) {
    mkdirSync(dirname(csvPath), { recursive: true });
    this.csvPath = csvPath;
    this.phasePath = phasePath;
    this.intervalMs = intervalMs;
    this.child = null;
    this.nodeSamples = [];
  }

  start(pid = process.pid) {
    writeFileSync(this.phasePath, 'load');
    this.child = spawn(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(SCRIPTS, 'memwatch.ps1'),
        '-TargetPid',
        String(pid),
        '-Out',
        this.csvPath,
        '-PhaseFile',
        this.phasePath,
        '-IntervalMs',
        String(this.intervalMs),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    this.child.stdout.on('data', (d) => process.stderr.write(`[memwatch] ${d}`));
    this.child.stderr.on('data', (d) => process.stderr.write(`[memwatch:err] ${d}`));
    this.timer = setInterval(() => {
      const m = process.memoryUsage();
      this.nodeSamples.push({ phase: this.phase ?? 'load', rss: m.rss, heapUsed: m.heapUsed, external: m.external });
    }, this.intervalMs);
    return this;
  }

  setPhase(name) {
    this.phase = name;
    writeFileSync(this.phasePath, name);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.child) {
      const closed = new Promise((res) => this.child.once('close', res));
      this.child.kill();
      await closed;
    }
    return this.summary();
  }

  /** @returns {{overall:object, phases:object[], nodePeakMB:number}} */
  summary() {
    if (!existsSync(this.csvPath)) return { error: `no sample file at ${this.csvPath}` };
    const rows = readFileSync(this.csvPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((l) => {
        const [elapsed, pid, phase, ws, priv, peakWs, cpu, free] = l.split(',');
        return {
          elapsedMs: Number(elapsed),
          phase: String(phase),
          workingSet: Number(ws),
          privateBytes: Number(priv),
          peakWorkingSet: Number(peakWs),
          cpuMs: Number(cpu),
          freeRam: Number(free),
        };
      })
      .filter((r) => Number.isFinite(r.workingSet));
    if (rows.length === 0) return { error: 'watcher produced no samples' };
    const phases = {};
    for (const r of rows) {
      const p = (phases[r.phase] ??= { samples: 0, peakWorkingSetMB: 0, peakPrivateMB: 0, peakCpuMs: 0, minFreeRamMB: Infinity, firstMs: r.elapsedMs, lastMs: r.elapsedMs });
      p.samples += 1;
      p.lastMs = r.elapsedMs;
      p.peakWorkingSetMB = Math.max(p.peakWorkingSetMB, r.workingSet / 1048576);
      p.peakPrivateMB = Math.max(p.peakPrivateMB, r.privateBytes / 1048576);
      p.peakCpuMs = Math.max(p.peakCpuMs, r.cpuMs);
      p.minFreeRamMB = Math.min(p.minFreeRamMB, r.freeRam / 1048576);
    }
    for (const p of Object.values(phases)) {
      p.peakWorkingSetMB = +p.peakWorkingSetMB.toFixed(1);
      p.peakPrivateMB = +p.peakPrivateMB.toFixed(1);
      p.minFreeRamMB = +p.minFreeRamMB.toFixed(1);
      p.windowMs = p.lastMs - p.firstMs;
      p.cpuMsInWindow = Math.round(p.peakCpuMs - (p.cpuStartMs ?? 0));
      delete p.peakCpuMs;
    }
    const nodePeak = this.nodeSamples.length ? Math.max(...this.nodeSamples.map((s) => s.rss)) : 0;
    return {
      csv: this.csvPath,
      intervalMs: this.intervalMs,
      samples: rows.length,
      spanMs: rows[rows.length - 1].elapsedMs - rows[0].elapsedMs,
      osPeakWorkingSetMB: +(Math.max(...rows.map((r) => r.peakWorkingSet)) / 1048576).toFixed(1),
      sampledPeakWorkingSetMB: +(Math.max(...rows.map((r) => r.workingSet)) / 1048576).toFixed(1),
      minFreeRamMB: +(Math.min(...rows.map((r) => r.freeRam)) / 1048576).toFixed(1),
      nodePeakRSSMB: +(nodePeak / 1048576).toFixed(1),
      phases,
    };
  }
}

export function writeCsv(path, header, rows) {
  mkdirSync(dirname(path), { recursive: true });
  const esc = (v) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v));
  writeFileSync(path, [header.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n'));
  return path;
}

export function appendJsonl(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj) + '\n', { flag: 'a' });
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function rmIfExists(p) {
  try {
    rmSync(p);
  } catch {}
}
