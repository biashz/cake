import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseHandle } from 'node:sqlite';

// esbuild rewrites `node:sqlite` to a bare `sqlite` import it cannot resolve,
// so load the builtin through require, which the bundler leaves alone.
const loadBuiltin = createRequire(import.meta.url);
const { DatabaseSync } = loadBuiltin('node:sqlite') as typeof import('node:sqlite');

export { DatabaseSync };
export type Database = DatabaseHandle;
