/**
 * ESM resolution hooks for reading `@quran/core` straight from TypeScript.
 *
 * WHY THIS EXISTS. The content pipeline runs on plain `node` (see
 * package.json scripts) so it needs no bundler, and Node ≥ 23 strips TypeScript
 * types on its own. What Node does *not* do is resolve extensionless specifiers:
 * `core/src/mutashabihat/index.ts` imports `../normalize/arabic` with no
 * extension, which throws `ERR_MODULE_NOT_FOUND`.
 *
 * The engine is the single source of truth for "which ayah resembles which"
 * and AGENTS.md forbids forking its logic into `tools/content`, so the
 * alternative — re-implementing the similarity math here — is not available.
 * These hooks therefore teach the plain-Node loader what `vitest`/`vite`
 * already assume: try `<spec>`, then `<spec>.ts`, then `<spec>/index.ts`.
 *
 * Nothing is rewritten in the resolved modules; this only affects file lookup,
 * so the mutashabihat pack is computed by exactly the same code the unit tests
 * exercise.
 *
 * One more convention is covered: `core/src/integrity/verify.ts` (and the rest
 * of core under `moduleResolution: NodeNext`) writes `./normalize/arabic.js` for
 * what is on disk `arabic.ts`. Vite resolves that; plain Node answers
 * `ERR_MODULE_NOT_FOUND`, so a `.js`/`.mjs` tail is also retried as `.ts`.
 */

const TS_SUFFIXES = ['.ts', '/index.ts'];

/** Candidate specifiers for a failed relative lookup, in attempt order. */
function candidates(specifier) {
  const out = TS_SUFFIXES.map((suffix) => specifier + suffix);
  if (/\.m?js$/.test(specifier)) {
    out.push(specifier.replace(/\.m?js$/, '.ts'), `${specifier.replace(/\.m?js$/, '')}/index.ts`);
  }
  return out;
}

/** True for `./x` / `../x` style specifiers only (bare package names are left alone). */
function isRelativeSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (!isRelativeSpecifier(specifier) || err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    for (const candidate of candidates(specifier)) {
      try {
        return await nextResolve(candidate, context);
      } catch {
        /* keep trying */
      }
    }
    throw err;
  }
}
