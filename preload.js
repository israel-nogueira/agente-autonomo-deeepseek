// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentAPI', {
  run: (task, projectRoot) => ipcRenderer.invoke('agent:run', { task, projectRoot }),
  abort: () => ipcRenderer.invoke('agent:abort'),
  compact: () => ipcRenderer.invoke('agent:compact'),
  resetSession: () => ipcRenderer.invoke('agent:resetSession'),
  stats: () => ipcRenderer.invoke('agent:stats'),
  diagnose: () => ipcRenderer.invoke('agent:diagnose'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  disableDeepSeekFeatures: () => ipcRenderer.invoke('agent:disableDeepSeekFeatures'),
  isChatVisible: () => ipcRenderer.invoke('chat:isVisible'),
  toggleChat: () => ipcRenderer.invoke('chat:toggle'),
  onLog: (cb) => ipcRenderer.on('agent:log', (_, msg) => cb(msg)),
  onCommand: (cb) => ipcRenderer.on('agent:command', (_, cmd) => cb(cmd)),
  onResult: (cb) => ipcRenderer.on('agent:result', (_, r) => cb(r)),
  onDeepSeekStatus: (cb) => ipcRenderer.on('deepseek:status', (_, data) => cb(data)),
  onChatWindowState: (cb) => ipcRenderer.on('chatwindow:state', (_, data) => cb(data)),
  onRunBatchRequest: (cb) => ipcRenderer.on('run:batch-request', (_, data) => cb(data)),
  sendRunBatchResponse: (data) => ipcRenderer.send('run:batch-response', data),
  onStats: (cb) => ipcRenderer.on('agent:stats', (_, data) => cb(data)),
});

// marked@4 e' CJS: require('marked') funciona direto no preload.
// (marked@18+ e' ESM-only e por isso falhava com "module not found".)
contextBridge.exposeInMainWorld('markdownAPI', {
  parse: (md) => {
    try {
      const { marked } = require('marked');
      const markedAlert = require('marked-alert');
      if (!marked.__alertInstalled) {
        marked.use(markedAlert());
        marked.__alertInstalled = true;
      }
      return marked.parse(String(md || ''), { breaks: true, gfm: true });
    } catch (e) {
      console.error('[markdownAPI] marked.parse falhou:', e && e.message);
      return null;
    }
  },
});

contextBridge.exposeInMainWorld('highlightAPI', {
  highlight: (code, lang) => {
    try {
      const hljs = require('highlight.js');
      const l = String(lang || '').toLowerCase();
      if (!l || !hljs.getLanguage(l)) return null;
      return hljs.highlight(String(code || ''), { language: l, ignoreIllegals: true }).value;
    } catch (e) {
      return null;
    }
  },
});

contextBridge.exposeInMainWorld('projectsAPI', {
  state: () => ipcRenderer.invoke('projects:state'),
  list: () => ipcRenderer.invoke('projects:list'),
  create: (opts) => ipcRenderer.invoke('projects:create', opts || {}),
  rename: (projectId, name) => ipcRenderer.invoke('projects:rename', { projectId, name }),
  setRoot: (projectId, projectRoot) => ipcRenderer.invoke('projects:setRoot', { projectId, projectRoot }),
  delete: (projectId, remote) => ipcRenderer.invoke('projects:delete', { projectId, remote: !!remote }),
  setActive: (projectId) => ipcRenderer.invoke('projects:setActive', { projectId }),
  listChats: (projectId) => ipcRenderer.invoke('projects:listChats', { projectId }),
  addChat: (projectId, uuid, url, label) =>
    ipcRenderer.invoke('projects:addChat', { projectId, uuid, url, label }),
  renameChat: (projectId, uuid, label) =>
    ipcRenderer.invoke('projects:renameChat', { projectId, uuid, label }),
  renameChatRemote: (uuid, title) =>
    ipcRenderer.invoke('projects:renameChatRemote', { uuid, title }),
  deleteChat: (projectId, uuid, remote) =>
    ipcRenderer.invoke('projects:deleteChat', { projectId, uuid, remote: !!remote }),
  switchChat: (projectId, uuid) =>
    ipcRenderer.invoke('projects:switchChat', { projectId, uuid }),
  openSessionPopup: (uuid, label) =>
    ipcRenderer.invoke('projects:openSessionPopup', { uuid, label }),
  onChanged: (cb) => ipcRenderer.on('projects:changed', (_, state) => cb(state)),
});

contextBridge.exposeInMainWorld('historyAPI', {
  append: (projectId, chatId, entries) =>
    ipcRenderer.invoke('history:append', { projectId, chatId, entries }),
  readLast: (projectId, chatId) =>
    ipcRenderer.invoke('history:readLast', { projectId, chatId }),
  readPage: (projectId, chatId, page) =>
    ipcRenderer.invoke('history:readPage', { projectId, chatId, page }),
});

contextBridge.exposeInMainWorld('appAPI', {
  onReady: (cb) => ipcRenderer.on('app:ready', (_, data) => cb(data)),
  retryBoot: () => ipcRenderer.invoke('app:retryBoot'),
});