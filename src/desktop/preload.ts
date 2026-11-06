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
  forkSession: (id) => ipcRenderer.invoke('session:fork', { id }),
  exportSession: (id, file) => ipcRenderer.invoke('session:export', { id, file }),

  run: (sessionId, prompt) => ipcRenderer.invoke('agent:run', { sessionId, prompt }),
  abort: () => ipcRenderer.invoke('agent:abort'),
  respondPermission: (id, decision) => ipcRenderer.invoke('permission:respond', { id, decision }),

  setModel: (model) => ipcRenderer.invoke('model:set', model),
  setMode: (mode) => ipcRenderer.invoke('mode:set', { mode }),
  setPricing: (pattern, rates) => ipcRenderer.invoke('pricing:set', { pattern, rates }),
  getCost: () => ipcRenderer.invoke('cost:get'),
  setRule: (action, list, scope, rule) =>
    ipcRenderer.invoke('rules:set', { action, list, scope, rule }),
  moveRule: (list, scope, rule, delta) =>
    ipcRenderer.invoke('rules:move', { list, scope, rule, delta }),
  reloadMcp: () => ipcRenderer.invoke('mcp:reload'),
  setMcpServer: (scope, draft) => ipcRenderer.invoke('mcp:set', { scope, draft }),
  removeMcpServer: (scope, name) => ipcRenderer.invoke('mcp:remove', { scope, name }),
  setMcpEnabled: (scope, name, enabled) =>
    ipcRenderer.invoke('mcp:enabled', { scope, name, enabled }),
  listFiles: (query) => ipcRenderer.invoke('files:list', { query }),
  runDoctor: () => ipcRenderer.invoke('doctor:run'),
  setProviderKey: (provider, key) => ipcRenderer.invoke('doctor:key', { provider, key }),
  rebuildIndex: () => ipcRenderer.invoke('doctor:reindex'),
  openDoctorFile: (target) => ipcRenderer.invoke('doctor:open', target),
  revealDoctorStore: (target) => ipcRenderer.invoke('doctor:reveal', target),
  contextLayers: () => ipcRenderer.invoke('context:layers'),

  onAgentEvent: subscribe('agent:event'),
  onAgentNote: subscribe('agent:note'),
  onPermissionRequest: subscribe('permission:request'),
  onMcpStatus: subscribe('mcp:status'),
};

contextBridge.exposeInMainWorld('cake', api);
