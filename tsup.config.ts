import { defineConfig } from 'tsup';

const externals = ['web-tree-sitter', '@vscode/tree-sitter-wasm', '@modelcontextprotocol/sdk'];

export default defineConfig([
  {
    entry: ['src/cli.tsx'],
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    external: externals,
    sourcemap: true,
    clean: true,
    dts: false,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: {
      main: 'src/desktop/main.ts',
      preload: 'src/desktop/preload.ts',
      smoke: 'src/desktop/smoke.ts',
    },
    outDir: 'dist/desktop',
    format: ['cjs'],
    target: 'node22',
    platform: 'node',
    external: ['electron', ...externals],
    // node:sqlite / tree-sitter loaders call createRequire(import.meta.url).
    shims: true,
    sourcemap: true,
    clean: false,
    dts: false,
  },
]);
