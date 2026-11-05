import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VERSION } from './version.js';

/**
 * The SEA build embeds the tree-sitter wasm files, but web-tree-sitter needs real
 * file paths. Extract them to a versioned cache dir and point CAKE_WASM_DIR at it.
 *
 * `node:sea` is imported dynamically: the SEA ESM entry cannot statically link it.
 */
export async function prepareSeaAssets(): Promise<void> {
  // The specifier is assembled at runtime: esbuild would otherwise strip the
  // `node:` prefix, which the SEA loader rejects.
  const sea = (await import(['node', 'sea'].join(':'))) as typeof import('node:sea');
  if (!sea.isSea()) return;
  const dir = path.join(os.homedir(), '.cake', 'runtime', VERSION, 'wasm');
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const key of sea.getAssetKeys()) {
      const file = path.join(dir, path.basename(key));
      if (fs.existsSync(file) && fs.statSync(file).size > 0) continue;
      fs.writeFileSync(file, Buffer.from(sea.getAsset(key)));
    }
    process.env.CAKE_WASM_DIR = dir;
  } catch (err) {
    process.stderr.write(`[cake] wasm extraction failed: ${(err as Error).message}\n`);
  }
}
