/**
 * ESM resolve hook so these experiment scripts can import the *real* engine
 * (`core/src/**\/*.ts`) with plain Node.
 *
 * `core` is TypeScript with extensionless relative imports (`../normalize/arabic`),
 * which Node's ESM resolver rejects. Rather than fork a copy of the normaliser
 * into this experiment — which would make the comparison meaningless — every
 * script here runs through this hook, so the numbers come from the shipped
 * code paths, not a re-implementation.
 *
 *   node --import ./scripts/lib/register-hooks.mjs <script>
 *
 * Nothing in core is modified.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-resolve.mjs', pathToFileURL(`${import.meta.dirname}/`));
