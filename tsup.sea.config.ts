import { defineConfig } from 'tsup';

// Ink conditionally loads devtools when DEV=true; the optional peer isn't installed,
// so swap it for a no-op stub instead of leaving an unresolvable external import.
const stubDevtools = {
  name: 'stub-react-devtools-core',
  setup(build: {
    onResolve: (options: { filter: RegExp }, cb: () => { path: string; namespace: string }) => void;
    onLoad: (
      options: { filter: RegExp; namespace: string },
      cb: () => { contents: string; loader: 'js' },
    ) => void;
  }) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'devtools-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'devtools-stub' }, () => ({
      contents: 'export default { initialize() {}, connectToDevTools() {} };',
      loader: 'js' as const,
    }));
  },
};

// Fully self-contained ESM bundle used as the SEA main script; every dependency
// except Node builtins is inlined so the executable needs no node_modules.
// ESM is required because Ink 8 uses top-level await, which cannot be emitted as CJS.
export default defineConfig({
  entry: { bundle: 'src/cli.tsx' },
  outDir: 'dist/sea',
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  noExternal: [/.*/],
  splitting: false,
  outExtension: () => ({ js: '.mjs' }),
  // CJS deps may call require() dynamically; give the ESM bundle a real require.
  banner: {
    js: "import { createRequire as __cakeCreateRequire } from 'node:module';\nconst require = __cakeCreateRequire(import.meta.url);",
  },
  esbuildPlugins: [stubDevtools as never],
  sourcemap: false,
  clean: true,
  dts: false,
});
