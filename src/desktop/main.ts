import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { VERSION } from '../version.js';
import { WorkspaceController } from './controller.js';
import { createHandlers, parseWorkspacePath } from './ipc.js';
import { desktopStateFile } from './state.js';

const devUrl = process.env.CAKE_RENDERER_URL;
// Lets automated runs (and portable installs) keep Electron data out of the user profile.
if (process.env.CAKE_USER_DATA) app.setPath('userData', process.env.CAKE_USER_DATA);
let mainWindow: BrowserWindow | undefined;

function rendererIndex(): string {
  const root = app.isPackaged ? app.getAppPath() : process.cwd();
  return path.join(root, 'dist', 'renderer', 'index.html');
}

function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        ],
      },
    });
  });
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 600,
    title: `Cake ${VERSION}`,
    backgroundColor: '#f5efe4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow = win;

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (devUrl && url.startsWith(devUrl)) return;
    event.preventDefault();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined;
  });

  if (devUrl) await win.loadURL(devUrl);
  else await win.loadFile(rendererIndex());
  return win;
}

app.whenReady().then(async () => {
  if (!devUrl) applyCsp();

  const controller = new WorkspaceController({
    stateFile: desktopStateFile(app.getPath('userData')),
    send: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
      }
    },
    openFile: (file) => shell.openPath(file),
    revealFile: (file) => shell.showItemInFolder(file),
  });

  for (const [channel, handler] of Object.entries(createHandlers(controller))) {
    ipcMain.handle(channel, (_event, payload) => handler(payload));
  }
  ipcMain.handle('workspace:pick', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Open a workspace',
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('workspace:open', async (_event, payload) => {
    return controller.openWorkspace(parseWorkspacePath(payload));
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void controller.dispose().finally(() => app.quit());
  });

  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
