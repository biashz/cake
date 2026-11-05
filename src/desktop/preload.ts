import { contextBridge, ipcRenderer } from 'electron';
import type { CakeApi } from './api.js';

type Unsubscribe = () => void;

function subscribe<T>(channel: string): (handler: (payload: T) => void) => Unsubscribe {
  return (handler) => {
    const listener = (_event: unknown, payload: T) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

const api: CakeApi = {
  init: () => ipcRenderer.invoke('app:init'),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  openWorkspace: (path) => ipcRenderer.invoke('workspace:open', { path }),

  listSessions: () => ipcRenderer.invoke('session:list'),
  newSession: () => ipcRenderer.invoke('session:new'),
  openSession: (id) => ipcRenderer.invoke('session:open', { id }),
  renameSession: (id, title) => ipcRenderer.invoke('session:rename', { id, title }),
  deleteSession: (id) => ipcRenderer.invoke('session:delete', { id }),

  run: (sessionId, prompt) => ipcRenderer.invoke('agent:run', { sessionId, prompt }),
  abort: () => ipcRenderer.invoke('agent:abort'),
  respondPermission: (id, decision) => ipcRenderer.invoke('permission:respond', { id, decision }),

  setModel: (model) => ipcRenderer.invoke('model:set', model),
  setMode: (mode) => ipcRenderer.invoke('mode:set', { mode }),
  reloadMcp: () => ipcRenderer.invoke('mcp:reload'),
  listFiles: (query) => ipcRenderer.invoke('files:list', { query }),
  runDoctor: () => ipcRenderer.invoke('doctor:run'),

  onAgentEvent: subscribe('agent:event'),
  onAgentNote: subscribe('agent:note'),
  onPermissionRequest: subscribe('permission:request'),
  onMcpStatus: subscribe('mcp:status'),
};

contextBridge.exposeInMainWorld('cake', api);
