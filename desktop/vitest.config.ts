/**
 * Test config lives here rather than in `vite.config.ts` so the app build stays
 * type-clean (`tsc --noEmit` only covers `src`), while `vitest` still gets a
 * first-class config. Node environment: the tests exercise the pure importer,
 * record mapping and schema code, not DOM.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
