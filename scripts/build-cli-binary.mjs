import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seaDir = path.join(root, 'dist', 'sea');
const main = path.join(seaDir, 'bundle.mjs');
const outDir = path.join(root, 'release');
const exe = path.join(outDir, 'cake.exe');
const MIN_SEA_NODE = [26, 9];

function versionOf(nodeExe) {
  return execFileSync(nodeExe, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');
}

// ESM SEA entries (mainFormat: module) need Node >= 26.9; the local runtime may be older.
const nodeExe = process.env.CAKE_SEA_NODE ?? process.execPath;
const [major = 0, minor = 0] = versionOf(nodeExe).split('.').map(Number);
if (major < MIN_SEA_NODE[0] || (major === MIN_SEA_NODE[0] && minor < MIN_SEA_NODE[1])) {
  throw new Error(
    `SEA base runtime must be Node >= ${MIN_SEA_NODE.join('.')} (found ${major}.${minor}); set CAKE_SEA_NODE to a newer node executable`,
  );
}

execSync('npx tsup --config tsup.sea.config.ts', { cwd: root, stdio: 'inherit' });
if (!fs.existsSync(main)) throw new Error(`missing SEA bundle: ${main}`);

const assets = {
  'web-tree-sitter.wasm': path.join(
    root,
    'node_modules',
    'web-tree-sitter',
    'web-tree-sitter.wasm',
  ),
};
const langDir = path.join(root, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');
for (const file of fs.readdirSync(langDir)) {
  if (/^tree-sitter-.*\.wasm$/.test(file)) assets[file] = path.join(langDir, file);
}

const configPath = path.join(seaDir, 'sea-config.json');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  configPath,
  JSON.stringify({
    main,
    mainFormat: 'module',
    output: exe,
    disableExperimentalSEAWarning: true,
    assets,
  }),
);

execFileSync(nodeExe, [`--build-sea=${configPath}`], { stdio: 'inherit' });

const sizeMb = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);
const version = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
console.log(
  `[sea] ${exe} (${sizeMb} MB, ${Object.keys(assets).length} wasm assets) -> cake ${version}`,
);
