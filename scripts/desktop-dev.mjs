import { spawn } from 'node:child_process';

const RENDERER_URL = 'http://localhost:5173';
const isWindows = process.platform === 'win32';

const vite = spawn('npx', ['vite', '--config', 'web/vite.config.ts'], {
  stdio: 'inherit',
  shell: isWindows,
});

let electron;

async function waitForRenderer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(RENDERER_URL);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite dev server did not start at ${RENDERER_URL}`);
}

function shutdown(code) {
  electron?.kill();
  vite.kill();
  process.exit(code ?? 0);
}

waitForRenderer()
  .then(() => {
    electron = spawn('npx', ['electron', '.'], {
      stdio: 'inherit',
      shell: isWindows,
      env: { ...process.env, CAKE_RENDERER_URL: RENDERER_URL },
    });
    electron.on('exit', (code) => shutdown(code));
  })
  .catch((err) => {
    console.error(`[desktop:dev] ${err.message}`);
    shutdown(1);
  });

vite.on('exit', (code) => {
  if (code !== 0) shutdown(code ?? 1);
});
process.on('SIGINT', () => shutdown(0));
