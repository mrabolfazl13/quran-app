/**
 * Registers `tsResolveHooks.mjs` on the Node module loader.
 *
 * Used as `node --import ./src/registerTsResolver.mjs src/build.ts` so the
 * build step can `import` the real mutashabihat engine out of `core/src`
 * instead of duplicating it. See `tsResolveHooks.mjs` for why a hook is needed.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./tsResolveHooks.mjs', import.meta.url);
