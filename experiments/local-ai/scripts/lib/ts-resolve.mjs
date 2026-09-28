/**
 * Resolve-hook implementation: retry a failed relative import with `.ts` and
 * `/index.ts` appended. Only used by the local-AI experiments.
 */
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function looksLikeFile(url) {
  try {
    return existsSync(fileURLToPath(url)) && statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
  if (!isRelative || !context.parentURL || /\.[cm]?[jt]s$/.test(specifier)) {
    return nextResolve(specifier, context);
  }
  const base = new URL(specifier, context.parentURL);
  for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
    if (looksLikeFile(candidate)) {
      return nextResolve(candidate, context);
    }
  }
  return nextResolve(specifier, context);
}
