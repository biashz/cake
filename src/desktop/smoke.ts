import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import type { InitPayload } from './api.js';
import { WorkspaceController } from './controller.js';
import { createHandlers } from './ipc.js';

/**
 * Headless end-to-end smoke: boots a hidden window with the real preload bridge,
 * opens a throwaway workspace, and prints the IPC handshake result.
 */
async function main(): Promise<void> {
  await app.whenReady();
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-smoke-'));
  const controller = new WorkspaceController({
    stateFile: path.join(workspace, 'state.json'),
    send: () => {},
  });

  try {
    await controller.openWorkspace(workspace);
    for (const [channel, handler] of Object.entries(createHandlers(controller))) {
      ipcMain.handle(channel, (_event, payload) => handler(payload));
    }
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await win.loadFile(path.join(process.cwd(), 'dist', 'renderer', 'index.html'));

    const rendererLogs: string[] = [];
    win.webContents.on('console-message', (event) => {
      rendererLogs.push(`[${event.level}] ${event.message}`);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      rendererLogs.push(`[gone] ${details.reason}`);
    });

    const payload = (await win.webContents.executeJavaScript('window.cake.init()')) as InitPayload;
    const rendered = (await win.webContents
      .executeJavaScript(
        `new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const timer = setInterval(() => {
          const el = document.querySelector('.brand-mark');
          if (el) { clearInterval(timer); resolve(el.textContent); }
          else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('renderer did not mount')); }
        }, 50);
      })`,
      )
      .catch(async (err: unknown) => {
        const body = (await win.webContents.executeJavaScript('document.body.innerHTML')) as string;
        throw new Error(
          [
            err instanceof Error ? err.message : String(err),
            ...rendererLogs,
            `body=${body.slice(0, 400)}`,
          ].join('\n'),
        );
      })) as string;

    const keys = payload.missingKeys.length > 0 ? payload.missingKeys.join(',') : 'none';
    const mcp = payload.mcpStatus.servers.length > 0 ? payload.mcpStatus.servers.join(',') : 'none';
    process.stdout.write(
      `${[
        `[smoke] version=${payload.version}`,
        `[smoke] workspace=${payload.workspace?.cwd ?? 'none'}`,
        `[smoke] session=${payload.workspace?.sessionId.slice(0, 8) ?? 'none'}`,
        `[smoke] providers=${payload.providers.map((p) => p.id).join(',')}`,
        `[smoke] missingKeys=${keys}`,
        `[smoke] mcp=${mcp}`,
        `[smoke] renderer=${rendered}`,
        '[smoke] ok',
      ].join('\n')}\n`,
    );
    win.destroy();
  } finally {
    await controller.dispose();
    await rm(workspace, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[smoke] failed: ${err instanceof Error ? err.message : String(err)}\n`);
  app.exit(1);
});
