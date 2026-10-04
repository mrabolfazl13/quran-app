/**
 * tests/e2e/lib/netgate.mjs — the "offline means offline" gate.
 *
 * What this proves: every request the packaged app's page makes is answered from
 * the app's own bytes — the Tauri asset host, the IPC origin that carries
 * `invoke()` calls, the loopback port the web bundle is served on, or a
 * file/blob/data URI produced locally. Anything else is a FAILURE, not a warning
 * (AGENTS.md: runtime fetches are a defect).
 *
 * What this cannot prove: that the machine had no network. The adapter is never
 * disabled and the Windows firewall is never touched — both are machine-wide
 * shared state. See `--manual-cable-check` in run.mjs for the operator step that
 * closes that gap by hand. `docs/current-state.md` records the same distinction
 * ("request-level evidence rather than a powered-off-network gate").
 *
 * `--network-block` goes one step further without touching the machine: the CDP
 * Fetch domain intercepts *this page's* requests and fails any that is not on
 * the allowlist, so a feature that quietly needed the network would break here
 * and be reported as such.
 */

/** Origins a fully offline app is allowed to talk to. */
export const LOCAL_PATTERNS = [
  /^https?:\/\/tauri\.localhost(:\d+)?\//i,
  /^tauri:\/\/localhost\//i,
  /^tauri:\/\/ipc\//i,
  /^https?:\/\/ipc\.localhost(:\d+)?\//i,
  /^ipc:\/\//i,
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i,
  /^file:\/\//i,
  /^data:/i,
  /^blob:(https?|file|tauri):/i,
  /^about:blank$/i,
];

/**
 * Build the classifier for one run. `webOrigin` is only non-empty for the served
 * web bundle, where the loopback port is legitimately part of the app.
 */
export function makeLocalClassifier({ webOrigin = null } = {}) {
  const extra = webOrigin ? [new RegExp(`^${escapeRegExp(webOrigin)}(/|$)`, 'i')] : [];
  return function isLocal(url) {
    if (typeof url !== 'string' || url.length === 0) return false;
    return [...LOCAL_PATTERNS, ...extra].some((pattern) => pattern.test(url));
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Group observed URLs by origin so the report shows who was actually asked. */
export function originBuckets(urls, isLocal) {
  const buckets = new Map();
  for (const url of urls) {
    let key;
    try {
      const parsed = new URL(url);
      key = `${parsed.protocol}//${parsed.host}`;
    } catch {
      key = url.slice(0, 40);
    }
    const entry = buckets.get(key) ?? { count: 0, local: isLocal(url), sample: url };
    entry.count += 1;
    buckets.set(key, entry);
  }
  return [...buckets.entries()]
    .map(([origin, value]) => ({ origin, ...value }))
    .sort((a, b) => b.count - a.count);
}

/** The offenders: requests that left the machine's own addresses. */
export function offenders(requests, isLocal) {
  return requests.filter((entry) => !isLocal(entry.url)).map((entry) => entry.url);
}
