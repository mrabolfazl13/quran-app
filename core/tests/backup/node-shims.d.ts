/**
 * Minimal ambient types for the Node built-ins the backup tests drive.
 *
 * The core workspace has no `@types/node` (and the test tsconfig locks
 * `types` to vitest globals), but the backup suite deliberately exercises a
 * REAL database (`node:sqlite`) and the `node:crypto` oracle for sha256.
 * These are hand-written narrow declarations for exactly what the tests use —
 * no dependency installs, and the runtime APIs are Node 24's own.
 */

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: unknown): string;
}

declare module 'node:crypto' {
  export function createHash(algorithm: 'sha256'): {
    update(data: Uint8Array): { digest(encoding: 'hex'): string };
  };
}

declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export interface StatementSync {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
}

interface UrlLike {
  toString(): string;
}

/** `import.meta.url` is a runtime guarantee of ESM on Node; vitest provides it. */
interface ImportMeta {
  readonly url: string;
}interface NodeTestGlobals {
  (url: string, base?: string): UrlLike;
  new (url: string, base?: string): UrlLike;
}
declare const URL: NodeTestGlobals;

interface PerformanceLike {
  now(): number;
}
declare const performance: PerformanceLike;

declare function structuredClone<T>(value: T): T;
