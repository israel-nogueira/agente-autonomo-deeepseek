// main.js
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { runAgent, pruneSessionLog } = require('./agent/loop');
const history = require('./agent/history');
const { compactSession } = require('./agent/compact');
const { disableDeepSeekFeatures, resetChat, requestAbort, waitChatReady, resetAbortFlag } = require('./agent/bridge');
const { killActiveProcesses, resetReadCache } = require('./agent/tools');
const projects = require('./agent/projects');
const gitguard = require('./agent/gitguard');

let win = null;
let splashWindow = null;
let chatWindow = null;
let chatPopup = null;

let sessionLog = [];
let tasksCount = 0;
let lastSummary = '';
let activeProjectId = null;
let activeChatUuid = null;

let deepSeekReady = false;
let abortRequested = false;
let running = false;
let currentRunId = 0;
let isQuitting = false;

let busyNavigation = false;
let currentTurnLog = null;

// Set<string> usado pelo loop.js para permitir RUNs sem confirmacao.
// Mantido como Set (loop.js usa .has/.add), mas o TTL e' aplicado em
// loadRunAllowlistIntoMemory/persistRunAllowlist/pruneRunAllowlist usando
// o timestamp persistido em projects.runAllowlistTs.
const runAllowlist = new Set();

// UUIDs de chats que ja foram apagados no DeepSeek nesta execucao.
// Evita repetir a chamada remota quando o usuario clica "remover" 2x.
const SUCCEEDED_THIS_SESSION = new Set();

const RUN_HARD_TIMEOUT_MS = 35 * 60 * 1000;
const NAVIGATION_TIMEOUT_MS = 20000;
const BOOT_TIMEOUT_MS = 20000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_ALLOWLIST_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FAKE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ============================================================
// Persistencia de posicao/tamanho das janelas
// ============================================================
function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); }
  catch (e) { return {}; }
}

function saveWindowState() {
  try {
    const state = {};
    if (win && !win.isDestroyed()) state.agent = win.getBounds();
    if (chatWindow && !chatWindow.isDestroyed()) state.chat = chatWindow.getBounds();
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
  } catch (e) { /* ignora */ }
}

function attachStateSaver(winRef) {
  let t = null;
  const save = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; saveWindowState(); }, 500);
  };
  winRef.on('resize', save);
  winRef.on('move', save);
}

// ============================================================
// Splash window
// ============================================================
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 520, height: 320,
    frame: false, transparent: true, resizable: false, movable: true,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, center: true, show: true, alwaysOnTop: false, hasShadow: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  splashWindow.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  splashWindow.on('closed', () => { splashWindow = null; });
  return splashWindow;
}

function splashStatus(message) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  try { splashWindow.webContents.send('splash:status', { message: message }); } catch (e) {}
}

function splashError(message) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  try { splashWindow.webContents.send('splash:error', { message: message }); } catch (e) {}
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    try { splashWindow.close(); } catch (e) {}
    splashWindow = null;
  }
}

// ============================================================
// Projeto / chat ativo
// ============================================================
function persistActiveChatState() {
  if (!activeProjectId || !activeChatUuid) return;
  try {
    projects.updateChatState(activeProjectId, activeChatUuid, {
      sessionLog: sessionLog,
      tasksCount: tasksCount,
      lastSummary: lastSummary,
    });
  } catch (e) { console.warn('[main] persistActiveChatState falhou:', e.message); }
}

function loadChatStateIntoMemory(projectId, chatUuid) {
  const chat = projects.getChat(projectId, chatUuid);
  if (!chat) {
    sessionLog = []; tasksCount = 0; lastSummary = '';
    return false;
  }
  sessionLog = Array.isArray(chat.sessionLog) ? chat.sessionLog.slice() : [];
  tasksCount = Number.isFinite(chat.tasksCount) ? chat.tasksCount : 0;
  lastSummary = typeof chat.lastSummary === 'string' ? chat.lastSummary : '';
  return true;
}

// Carrega allowlist do projeto descartando:
//   - comandos sem timestamp (dados antigos) — expirados por definicao
//   - comandos com timestamp mais antigo que RUN_ALLOWLIST_TTL_MS
// e PERSISTE a lista ja limpa (runAllowlist + runAllowlistTs juntos).
function loadRunAllowlistIntoMemory(projectId) {
  runAllowlist.clear();
  try {
    const list = projects.getRunAllowlist(projectId) || [];
    const ts = projects.getRunAllowlistTs(projectId) || {};
    const now = Date.now();
    const alive = [];
    const aliveTs = {};
    for (const cmd of list) {
      const t = ts[cmd];
      if (typeof t !== 'number' || !Number.isFinite(t)) continue;
      if (now - t > RUN_ALLOWLIST_TTL_MS) continue;
      alive.push(cmd);
      aliveTs[cmd] = t;
      runAllowlist.add(cmd);
    }
    // Persiste a lista ja limpa (se algo foi descartado, evita lixo no JSON).
    if (alive.length !== list.length) {
      try {
        projects.setRunAllowlist(projectId, alive);
        projects.setRunAllowlistTs(projectId, aliveTs);
      } catch (e) {}
    }
  } catch (e) {}
}

// A memoria (runAllowlist) e' a fonte da verdade. Para cada cmd em
// memoria, usa o ts do projeto (ou Date.now() se faltar); descarta
// expirados (removendo tambem do Set); grava SO os vivos (setRunAllowlist
// + setRunAllowlistTs). Nao le a lista do projeto para manter itens fora
// da memoria — assim runAllowlist.clear() + persistRunAllowlist() limpa.
function persistRunAllowlist() {
  if (!activeProjectId) return;
  try {
    const now = Date.now();
    const srcTs = projects.getRunAllowlistTs(activeProjectId) || {};
    const alive = [];
    const aliveTs = {};
    const toRemove = [];
    for (const cmd of runAllowlist) {
      let t = srcTs[cmd];
      if (typeof t !== 'number' || !Number.isFinite(t)) {
        // Sem timestamp no projeto: usa agora (defensivo).
        t = now;
      }
      if (now - t > RUN_ALLOWLIST_TTL_MS) {
        toRemove.push(cmd);
        continue;
      }
      alive.push(cmd);
      aliveTs[cmd] = t;
    }
    for (const cmd of toRemove) runAllowlist.delete(cmd);
    projects.setRunAllowlist(activeProjectId, alive);
    projects.setRunAllowlistTs(activeProjectId, aliveTs);
  } catch (e) {}
}

// Remove do Set em memoria (e do projeto, gravando as duas estruturas)
// os comandos expirados ou sem timestamp. Reutiliza a logica do
// persistRunAllowlist.
function pruneRunAllowlist() {
  persistRunAllowlist();
}

// onAlwaysAllow: grava comando + timestamp no projeto. O Set em memoria
// e' atualizado pra refletir imediatamente nesta sessao. NUNCA e' chamado
// para WRITE/EDIT sensivel (regra do loop + filtro no confirmRunBatch).
function addToRunAllowlist(cmd) {
  const trimmed = String(cmd || '').trim();
  if (!trimmed) return;
  runAllowlist.add(trimmed);
  if (!activeProjectId) return;
  try {
    const list = projects.getRunAllowlist(activeProjectId) || [];
    const ts = projects.getRunAllowlistTs(activeProjectId) || {};
    ts[trimmed] = Date.now();
    if (list.indexOf(trimmed) === -1) list.push(trimmed);
    projects.setRunAllowlist(activeProjectId, list);
    projects.setRunAllowlistTs(activeProjectId, ts);
  } catch (e) {}
}

function applyActiveState() {
  const active = projects.getActiveProject();
  if (!active) {
    activeProjectId = null; activeChatUuid = null;
    sessionLog = []; tasksCount = 0; lastSummary = '';
    runAllowlist.clear();
    return;
  }
  activeProjectId = active.id;
  activeChatUuid = active.activeChatUuid || null;
  loadRunAllowlistIntoMemory(activeProjectId);
  if (activeChatUuid) loadChatStateIntoMemory(activeProjectId, activeChatUuid);
  else { sessionLog = []; tasksCount = 0; lastSummary = ''; }
}

function notifyProjectsChanged() {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('projects:changed', buildProjectsState()); } catch (e) {}
  }
}

function buildProjectsState() {
  const projectList = projects.listProjects();
  const project = activeProjectId ? projects.getProject(activeProjectId) : null;
  const chats = project ? projects.listChats(project.id) : [];
  return {
    activeProjectId, activeChatUuid, projects: projectList, chats: chats,
    chat: activeChatUuid ? projects.getChat(activeProjectId, activeChatUuid) : null,
  };
}

function filterRealUuids(chats) {
  if (!Array.isArray(chats)) return [];
  const seen = new Set();
  const out = [];
  for (const c of chats) {
    if (!c || typeof c.uuid !== 'string') continue;
    if (c.uuid.indexOf('pending-') === 0) continue;
    if (seen.has(c.uuid)) continue;
    seen.add(c.uuid);
    out.push({ uuid: c.uuid, label: c.label || c.uuid });
  }
  return out;
}

// ============================================================
// Label automatico: "<slug>_NN" (01, 02, 03, ...)
// ============================================================
function nextSessionLabel(projectId) {
  const p = projects.getProject(projectId);
  if (!p) return 'sessao_01';
  const prefix = (p.slug || slugifyName(p.name)) + '_';
  // Escapa o prefix para uso em regex.
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped + '(\\d+)$');
  let maxN = 0;
  for (const c of p.chats) {
    if (!c || typeof c.label !== 'string') continue;
    const m = c.label.match(re);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > maxN) maxN = n;
  }
  const next = maxN + 1;
  return prefix + String(next).padStart(2, '0');
}

function slugifyName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'projeto';
}

function createPendingChat() {
  if (!activeProjectId) return null;
  const ts = 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const label = nextSessionLabel(activeProjectId);
  try {
    projects.addChat(activeProjectId, ts, 'https://chat.deepseek.com/', label);
    activeChatUuid = ts;
    return ts;
  } catch (e) {
    console.warn('[main] createPendingChat falhou:', e.message);
    return null;
  }
}

// ============================================================
// Janela do agente
// ============================================================
function createAgentWindow() {
  const saved = loadWindowState();
  const agentState = saved.agent || {};

  win = new BrowserWindow({
    width: agentState.width || 1150,
    height: agentState.height || 780,
    x: agentState.x, y: agentState.y,
    title: 'Agente DeepSeek',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,          // ← esta linha
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  attachStateSaver(win);
  // debug: mantido enquanto voce esta desenvolvendo
  win.webContents.openDevTools({ mode: 'detach' });

  // ITEM 8: bloquear navegacao e novas janelas da janela principal.
  // - novas janelas: sempre deny; http/https abrem no navegador externo.
  // - will-navigate: so permite o proprio index.html (file://); o resto
  //   e' bloqueado, e http/https abrem externo; outros protocolos so bloqueiam.
  const indexUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (typeof url === 'string' && /^https?:/i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
    } catch (e) {}
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    try {
      if (typeof url === 'string' && url.split('#')[0] === indexUrl) return;
      event.preventDefault();
      if (typeof url === 'string' && /^https?:/i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
    } catch (e) {
      try { event.preventDefault(); } catch (_) {}
    }
  });

  win.on('closed', () => {
    win = null;
    if (chatWindow && !chatWindow.isDestroyed()) chatWindow.destroy();
    if (chatPopup && !chatPopup.isDestroyed()) chatPopup.destroy();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  });
}

// ============================================================
// Janela do DeepSeek
// ============================================================
function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) return chatWindow;

  const saved = loadWindowState();
  const chatState = saved.chat || {};

  chatWindow = new BrowserWindow({
    width: chatState.width || 900,
    height: chatState.height || 900,
    x: chatState.x, y: chatState.y,
    title: 'DeepSeek',
    show: false,
    webPreferences: {
      partition: 'persist:deepseek',
      userAgent: FAKE_UA,
      contextIsolation: true, nodeIntegration: false,
    },
  });

  chatWindow.webContents.setUserAgent(FAKE_UA);

  chatWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); chatWindow.hide(); }
  });

  chatWindow.on('show', () => {
    if (win && !win.isDestroyed()) win.webContents.send('chatwindow:state', { visible: true });
  });

  chatWindow.on('hide', () => {
    if (win && !win.isDestroyed()) win.webContents.send('chatwindow:state', { visible: false });
  });

  chatWindow.webContents.on('dom-ready', () => {
    deepSeekReady = true;
    if (win && !win.isDestroyed()) {
      win.webContents.send('deepseek:status', { ready: true, msg: 'carregado' });
    }
    chatWindow.webContents.executeJavaScript(`
      (function() {
        try {
          if (!Object.getOwnPropertyDescriptor(navigator, 'webdriver')) {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
          }
        } catch (e) {}
        try { if (window.process) delete window.process; } catch (e) {}
        try { if (window.require) delete window.require; } catch (e) {}
        try { if (window.module) delete window.module; } catch (e) {}
        return 'OK';
      })()
    `).catch(() => {});
    disableDeepSeekFeatures(chatWindow);
  });

  attachStateSaver(chatWindow);
  // debug: mantido enquanto voce esta desenvolvendo
  chatWindow.webContents.openDevTools({ mode: 'detach' });

  chatWindow.on('closed', () => {
    chatWindow = null;
    deepSeekReady = false;
    if (win && !win.isDestroyed()) win.webContents.send('chatwindow:state', { visible: false });
  });

  const active = projects.getActiveChat(projects.getAll().activeProjectId);
  const startUrl = (active && active.url) || 'https://chat.deepseek.com/';
  chatWindow.loadURL(startUrl);
  return chatWindow;
}

// ============================================================
// Popup de sessao antiga (SOMENTE LEITURA)
// ============================================================
function openSessionPopup(uuid, label) {
  if (chatPopup && !chatPopup.isDestroyed()) { chatPopup.close(); chatPopup = null; }
  if (!uuid) return { ok: false, error: 'uuid vazio' };

  const url = projects.getChatUrl(uuid);
  chatPopup = new BrowserWindow({
    width: 1000, height: 820,
    title: 'DeepSeek — ' + (label || uuid) + ' (somente leitura)',
    parent: win || undefined, modal: false,
    webPreferences: {
      partition: 'persist:deepseek',
      userAgent: FAKE_UA,
      contextIsolation: true, nodeIntegration: false,
    },
  });
  chatPopup.loadURL(url);
  chatPopup.on('closed', () => { chatPopup = null; });
  return { ok: true };
}

// ============================================================
// Helpers
// ============================================================
function chatReady() {
  return chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents && !chatWindow.webContents.isDestroyed();
}

function chatVisible() { return chatReady() && chatWindow.isVisible(); }

function stats() {
  const totalChars = sessionLog.reduce((s, m) => s + (m.chars || 0), 0);
  return {
    tasks: tasksCount, messages: sessionLog.length, chars: totalChars,
    approxTokens: Math.round(totalChars / 4),
    hasSummary: lastSummary.length > 0,
    running: running, chatWindowVisible: chatVisible(),
  };
}

function statsLive() {
  const sessionChars = sessionLog.reduce((s, m) => s + (m.chars || 0), 0);
  let turnChars = 0, turnMessages = 0;
  if (Array.isArray(currentTurnLog)) {
    for (const m of currentTurnLog) {
      turnChars += (m && m.chars) ? m.chars : 0;
      turnMessages++;
    }
  }
  const totalChars = sessionChars + turnChars;
  return {
    tasks: tasksCount, messages: sessionLog.length + turnMessages, chars: totalChars,
    approxTokens: Math.round(totalChars / 4),
    hasSummary: lastSummary.length > 0,
    running: running, chatWindowVisible: chatVisible(),
  };
}

function statsAfterRun() { return { ...stats(), running: false }; }

// ============================================================
// Comum: token + headers x-client-* para a API do DeepSeek
// ============================================================
function buildClientApiCode() {
  return `
    function unwrapToken(v) {
      if (typeof v !== 'string') return null;
      try {
        var p = JSON.parse(v);
        if (p && typeof p.value === 'string') return p.value;
      } catch (e) {}
      return v;
    }

    function findToken() {
      try {
        var raw = localStorage.getItem('userToken');
        if (!raw) { try { raw = sessionStorage.getItem('userToken'); } catch (e) {} }
        if (raw) {
          var v = unwrapToken(raw);
          if (v && v.length >= 40) return { token: v, source: 'userToken' };
        }
      } catch (e) {}
      return { token: null, source: null };
    }

    function buildClientHeaders() {
      var h = {
        'x-client-bundle-id': 'com.deepseek.chat',
        'x-client-platform': 'web',
        'x-client-version': '2.7.1',
        'x-client-locale': 'pt_BR',
        'x-client-timezone-offset': String(new Date().getTimezoneOffset() * -60),
      };
      try {
        var did = localStorage.getItem('deepseek-device-id:chat') || localStorage.getItem('__ds_remote_feature_did');
        if (did) h['x-device-id'] = did;
      } catch (e) {}
      return h;
    }
  `;
}

// ============================================================
// DELETE REMOTO
//
// CORRIGIDO: agora tratamos status 401/403 como needsLogin tambem.
// Antes so json.code === 40003 / json.msg === 'INVALID_TOKEN' contava
// como auth error, e o app oferecia "Tentar de novo" em loop.
// ============================================================
async function deleteChatsRemote(items) {
  if (!chatReady()) return { ok: false, error: 'janela do DeepSeek nao existe', succeeded: [], failed: [] };
  if (!Array.isArray(items) || items.length === 0) return { ok: true, succeeded: [], failed: [] };

  const pending = items.filter(function (it) {
    return it && typeof it.uuid === 'string' && !SUCCEEDED_THIS_SESSION.has(it.uuid);
  });
  if (pending.length === 0) return { ok: true, succeeded: items.map(i => i.uuid), failed: [] };

  const uuids = pending.map(i => i.uuid);

  const code = `
    (async () => {
      const uuids = ${JSON.stringify(uuids)};
      const url = '/api/v0/chat_session/delete';
      const body = JSON.stringify({ chat_session_ids: uuids });
      ${buildClientApiCode()}
      var tokenInfo = findToken();
      var token = tokenInfo.token;

      async function tryFetch(withToken) {
        try {
          var headers = Object.assign(
            { 'Content-Type': 'application/json', 'Accept': '*/*' },
            buildClientHeaders()
          );
          if (withToken && token) headers['Authorization'] = 'Bearer ' + token;
          var r = await fetch(url, { method: 'POST', headers: headers, credentials: 'include', body: body });
          var text = await r.text();
          var json = null;
          try { json = JSON.parse(text); } catch (e) {}
          var codeOk = (json === null) || (json.code === 0) || (json.code === undefined) || (json.code === null);
          if (r.ok && codeOk) return { ok: true, via: withToken ? 'token' : 'cookie', status: r.status };

          var isAuthError = (r.status === 401 || r.status === 403) ||
                            !!(json && (json.code === 40003 || json.msg === 'INVALID_TOKEN'));
          return { ok: false, status: r.status, json: json, isAuthError: isAuthError, text: text.slice(0, 300) };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }

      var r1 = null;
      if (token) {
        r1 = await tryFetch(true);
        if (r1.ok) return r1;
      }
      var r2 = await tryFetch(false);
      if (r2.ok) return r2;

      return {
        ok: false,
        error: 'Falha ao apagar no DeepSeek: ' + ((r2 && (r2.text || r2.error)) || 'erro desconhecido'),
        needsLogin: !!(r2 && r2.isAuthError),
      };
    })()
  `;

  let res;
  try { res = await chatWindow.webContents.executeJavaScript(code, true); }
  catch (e) { res = { ok: false, error: 'executeJavaScript falhou: ' + e.message }; }

  if (res && res.ok) {
    for (const u of uuids) SUCCEEDED_THIS_SESSION.add(u);
    return { ok: true, succeeded: uuids, failed: [] };
  }

  return {
    ok: false,
    error: (res && res.error) || 'erro desconhecido',
    succeeded: [],
    failed: pending.map(it => ({ uuid: it.uuid, label: it.label || it.uuid, error: (res && res.error) || 'erro' })),
    needsLogin: !!(res && res.needsLogin),
  };
}

// ============================================================
// RENAME REMOTO (update_title)
// ============================================================
async function renameChatRemote(uuid, title) {
  if (!chatReady()) return { ok: false, error: 'janela do DeepSeek nao existe' };
  if (!uuid || !title) return { ok: false, error: 'uuid e title obrigatorios' };

  const code = `
    (async () => {
      const uuid = ${JSON.stringify(uuid)};
      const title = ${JSON.stringify(title)};
      const url = '/api/v0/chat_session/update_title';
      const body = JSON.stringify({ chat_session_id: uuid, title: title });
      ${buildClientApiCode()}
      var tokenInfo = findToken();
      var token = tokenInfo.token;

      try {
        var headers = Object.assign(
          { 'Content-Type': 'application/json', 'Accept': '*/*' },
          buildClientHeaders()
        );
        if (token) headers['Authorization'] = 'Bearer ' + token;
        var r = await fetch(url, { method: 'POST', headers: headers, credentials: 'include', body: body });
        var text = await r.text();
        var json = null;
        try { json = JSON.parse(text); } catch (e) {}
        var bizOk = !(json && json.data && json.data.biz_code !== undefined && json.data.biz_code !== 0);
        var ok = r.ok && json && (json.code === 0 || json.code === undefined) && bizOk;
        var needsLogin = (r.status === 401 || r.status === 403) ||
                         !!(json && json.code === 40003);
        return { ok: !!ok, status: r.status, text: text.slice(0, 600), needsLogin: needsLogin };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })()
  `;

  try {
    return await chatWindow.webContents.executeJavaScript(code, true);
  } catch (e) {
    return { ok: false, error: 'executeJavaScript falhou: ' + e.message };
  }
}

// ============================================================
// CONFIRM BATCH de RUNs / WRITE/EDIT sensiveis
//
// ITEM 11: o lote mistura itens de RUN com itens de WRITE/EDIT em path
// sensivel. Para RUN, item = { cmd, danger, kind:'run' }. Para WRITE/EDIT,
// item = { cmd:'GRAVAR: <path>', danger:<motivo>, kind:'write'|'edit',
// path, sensitive:true }.
//
// Defesa em profundidade: mesmo que o renderer marque "Sempre permitir"
// em um item sensivel, filtramos aqui — nenhum item `sensitive:true`
// entra no array `always`, e o loop tambem ignora decision.always para
// esses comandos.
// ============================================================
function confirmRunBatch(items) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) { resolve({ approved: [], always: [] }); return; }
    if (!Array.isArray(items) || items.length === 0) { resolve({ approved: [], always: [] }); return; }

    let resolved = false;
    const done = (data) => {
      if (resolved) return;
      resolved = true;
      ipcMain.removeListener('run:batch-response', handler);
      clearTimeout(timer);

      const raw = data || {};
      const approved = Array.isArray(raw.approved) ? raw.approved : [];
      const rawAlways = Array.isArray(raw.always) ? raw.always : [];
      const safeAlways = rawAlways.filter(function (idx) {
        const it = items[idx];
        return it && it.sensitive !== true;
      });
      resolve({ approved: approved, always: safeAlways });
    };

    const handler = (event, data) => { done(data); };
    ipcMain.once('run:batch-response', handler);

    const timer = setTimeout(() => {
      console.warn('[confirmRunBatch] timeout apos 5min, negando todos');
      done({ approved: [], always: [], timeout: true });
    }, 5 * 60 * 1000);

    try { win.webContents.send('run:batch-request', { items }); }
    catch (e) { console.warn('[confirmRunBatch] falha ao enviar IPC:', e.message); done({ approved: [], always: [] }); }
  });
}

// ============================================================
// IPC — janela do chat
// ============================================================
ipcMain.handle('chat:isVisible', () => chatVisible());

ipcMain.handle('chat:toggle', async () => {
  if (!chatReady()) return { ok: false, error: 'janela do DeepSeek nao existe' };
  if (chatWindow.isVisible()) { chatWindow.hide(); return { ok: true, visible: false }; }
  chatWindow.show(); chatWindow.focus();
  return { ok: true, visible: true };
});

ipcMain.handle('dialog:pickFolder', async () => {
  if (!win || win.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'], title: 'Escolha a pasta do projeto',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ============================================================
// IPC — projetos e chats
//
// CORRIGIDO: valida tipos basicos (string nao-vazia) antes de chamar
// projects.*. Sem isso, um XSS no renderer poderia chamar
// projectsAPI.delete(undefined, false) e causar exception obscura.
// ============================================================
function isNonEmptyString(x) { return typeof x === 'string' && x.length > 0; }

ipcMain.handle('projects:state', () => buildProjectsState());
ipcMain.handle('projects:list', () => projects.listProjects());

ipcMain.handle('projects:create', async (event, opts) => {
  if (running) return { ok: false, error: 'existe uma tarefa em andamento. Aguarde ou clique em Parar.' };
  if (busyNavigation) return { ok: false, error: 'existe uma operacao em andamento. Aguarde.' };
  try {
    busyNavigation = true;
    const name = (opts && typeof opts.name === 'string') ? opts.name : undefined;
    const slug = (opts && typeof opts.slug === 'string') ? opts.slug : undefined;
    const projectRoot = (opts && typeof opts.projectRoot === 'string') ? opts.projectRoot : undefined;
    const p = projects.createProject({ name, slug, projectRoot });
    persistActiveChatState();
    applyActiveState();
    resetReadCache();
    if (chatReady()) {
      try { await chatWindow.loadURL('https://chat.deepseek.com/'); } catch (e) {}
    }
    notifyProjectsChanged();
    return { ok: true, project: p, state: buildProjectsState(), stats: stats() };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { busyNavigation = false; }
});

ipcMain.handle('projects:rename', (event, { projectId, name }) => {
  if (!isNonEmptyString(projectId)) return { ok: false, error: 'projectId invalido' };
  if (typeof name !== 'string') return { ok: false, error: 'name invalido' };
  try { const p = projects.renameProject(projectId, name); notifyProjectsChanged(); return { ok: true, project: p }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('projects:setRoot', (event, { projectId, projectRoot }) => {
  if (!isNonEmptyString(projectId)) return { ok: false, error: 'projectId invalido' };
  if (typeof projectRoot !== 'string') return { ok: false, error: 'projectRoot invalido' };
  if (running) return { ok: false, error: 'existe uma tarefa em andamento. Aguarde ou clique em Parar.' };
  try { const p = projects.setProjectRoot(projectId, projectRoot); notifyProjectsChanged(); return { ok: true, project: p }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('projects:delete', async (event, { projectId, remote }) => {
  if (!isNonEmptyString(projectId)) return { ok: false, error: 'projectId invalido' };
  if (running) return { ok: false, error: 'existe uma tarefa em andamento. Aguarde ou clique em Parar.' };
  if (busyNavigation) return { ok: false, error: 'existe uma operacao em andamento. Aguarde.' };

  const project = projects.getProject(projectId);
  if (!project) return { ok: false, error: 'projeto inexistente' };

  const wantRemote = !!remote;
  const projectChats = Array.isArray(project.chats) ? project.chats.slice() : [];
  const realChats = filterRealUuids(projectChats);

  busyNavigation = true;
  try {
    if (wantRemote && realChats.length > 0) {
      if (!chatReady()) {
        return {
          ok: false, error: 'janela do DeepSeek nao existe (nao da para apagar no site).',
          remoteFailed: true,
          failures: [{ uuid: '*', label: '(todos)', error: 'janela do DeepSeek nao existe' }],
        };
      }
      const r = await deleteChatsRemote(realChats);
      if (!r.ok) {
        return {
          ok: false, error: r.error || 'DeepSeek recusou apagar os chats. O projeto foi mantido.',
          remoteFailed: true, failures: r.failed || [],
          succeededCount: 0, totalCount: realChats.length,
          needsLogin: !!r.needsLogin,
        };
      }
    }

    const wasActive = activeProjectId === projectId;
    const rr = projects.deleteProject(projectId);
    try { history.deleteProject(projectId); } catch (e) { /* ignora */ }

    if (wasActive) {
      applyActiveState();
      if (chatReady()) {
        const active = projects.getActiveChat(activeProjectId);
        const url = (active && active.url) || 'https://chat.deepseek.com/';
        try {
          await chatWindow.loadURL(url);
          await waitChatReady(chatWindow, NAVIGATION_TIMEOUT_MS);
        } catch (e) {}
      }
    }

    notifyProjectsChanged();
    return {
      ok: true, remoteDeleted: wantRemote && realChats.length > 0,
      activeProjectId: rr.activeProjectId,
      state: buildProjectsState(), stats: stats(),
    };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { busyNavigation = false; }
});

ipcMain.handle('projects:setActive', async (event, { projectId }) => {
  if (!isNonEmptyString(projectId)) return { ok: false, error: 'projectId invalido' };
  if (running) return { ok: false, error: 'existe uma tarefa em andamento. Aguarde ou clique em Parar.' };
  if (busyNavigation) return { ok: false, error: 'existe uma operacao em andamento. Aguarde.' };

  busyNavigation = true;
  try {
    persistActiveChatState();
    projects.setActiveProject(projectId);
    applyActiveState();
    SUCCEEDED_THIS_SESSION.clear();

    if (chatReady()) {
      const activeChat = projects.getActiveChat(projectId);
      const targetUrl = (activeChat && activeChat.url) || 'https://chat.deepseek.com/';
      try {
        await chatWindow.loadURL(targetUrl);
        await waitChatReady(chatWindow, NAVIGATION_TIMEOUT_MS);
      } catch (e) {
        notifyProjectsChanged();
        return { ok: false, error: 'DeepSeek demorou para responder: ' + e.message, stage: 'waitChatReady' };
      }
    }

    notifyProjectsChanged();
    return { ok: true, state: buildProjectsState(), stats: stats() };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { busyNavigation = false; }
});

ipcMain.handle('projects:listChats', (event, { projectId }) => {
  if (!isNonEmptyString(projectId)) return [];
  return projects.listChats(projectId);
});

ipcMain.handle('projects:addChat', async (event, { projectId, uuid, url, label }) => {
  if (!isNonEmptyString(projectId)) return { ok: false, error: 'projectId invalido' };
  if (!isNonEmptyString(uuid)) return { ok: false, error: 'uuid invalido' };
  if (running) return { ok: false, error: 'existe uma tarefa em andamento. Aguarde ou clique em Parar.' };
  try {
    const chat = projects.addChat(projectId, uuid, url, label);
    if (projectId === activeProjectId) {
      persistActiveChatState();
      loadChatStateIntoMemory(projectId, chat.uuid);
      activeChatUuid = chat.uuid;
    }
    notifyProjectsChanged();
    return { ok: true, chat, state: buildProjectsState(), stats: stats() };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('projects:renameChat', (event, { projectId, uuid, label }) => {
  if (!isNonEmptyString(projectId)) return { ok: false, error: 'projectId invalido' };
  if (!isNonEmptyString(uuid)) return { ok: false, error: 'uuid invalido' };
  if (typeof label !== 'string') return { ok: false, error: 'label invalido' };
  try {
    const chat = projects.renameChat(projectId, uuid, label);
    notifyProjectsChanged();
    return { ok: true, chat };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('projects:renameChatRemote', async (event, { uuid, title }) => {
  if (!isNonEmptyString(uuid)) return { ok: false, error: 'uuid invalido' };
  if (typeof title !== 'string' || !title.trim()) return { ok: false, error: 'title invalido' };
  try {
    const r = await renameChatRemote(uuid, title);
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('projects:deleteChat', async (event, { projectId, uuid, remote }) => {
  if (!isNonEmptyString(projectId)) return { ok: false, error: 'projectId invalido' };
  if (!isNonEmptyString(uuid)) return { ok: false, error: 'uuid invalido' };
  if (running) return { ok: false, error: 'existe uma tarefa em andamento. Aguarde ou clique em Parar.' };
  if (busyNavigation) return { ok: false, error: 'existe uma operacao em andamento. Aguarde.' };

  busyNavigation = true;
  try {
    const isActive = (projectId === activeProjectId && uuid === activeChatUuid);
    const wantRemote = !!remote;
    const isPending = typeof uuid === 'string' && uuid.indexOf('pending-') === 0;

    let prevUrl = null;
    if (isActive && chatReady()) {
      const p = projects.getProject(projectId);
      const idx = p ? p.chats.findIndex(c => c.uuid === uuid) : -1;
      const nextChat = (p && idx >= 0) ? (p.chats[idx + 1] || p.chats[idx - 1] || null) : null;
      const nextUrl = (nextChat && nextChat.url) || 'https://chat.deepseek.com/';
      try { prevUrl = chatWindow.webContents.getURL(); } catch (e) { prevUrl = null; }
      try {
        await chatWindow.loadURL(nextUrl);
        await waitChatReady(chatWindow, NAVIGATION_TIMEOUT_MS);
      } catch (e) {}
    }

    if (wantRemote && !isPending) {
      if (!chatReady()) return { ok: false, error: 'janela do DeepSeek nao existe.', remoteFailed: true };
      const r = await deleteChatsRemote([{ uuid: uuid, label: uuid }]);
      if (!r.ok) {
        if (isActive && prevUrl && chatReady()) {
          try {
            await chatWindow.loadURL(prevUrl);
            await waitChatReady(chatWindow, NAVIGATION_TIMEOUT_MS);
          } catch (e) {}
        }
        return {
          ok: false, error: r.error || 'DeepSeek recusou apagar o chat. O registro local foi mantido.',
          remoteFailed: true, failures: r.failed || [], needsLogin: !!r.needsLogin,
        };
      }
    }

    const r = projects.deleteChat(projectId, uuid);
    if (isActive) applyActiveState();

    try { history.deleteChat(projectId, uuid); } catch (e) { /* ignora */ }

    notifyProjectsChanged();
    return {
      ok: true, remoteDeleted: wantRemote && !isPending,
      activeChatUuid: r.activeChatUuid,
      state: buildProjectsState(), stats: stats(),
    };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { busyNavigation = false; }
});

ipcMain.handle('projects:switchChat', async (event, { projectId, uuid }) => {
  if (!isNonEmptyString(projectId)) return { ok: false, error: 'projectId invalido' };
  if (!isNonEmptyString(uuid)) return { ok: false, error: 'uuid invalido' };
  if (running) return { ok: false, error: 'existe uma tarefa em andamento. Aguarde ou clique em Parar antes de trocar de chat.' };
  if (busyNavigation) return { ok: false, error: 'existe uma operacao em andamento. Aguarde.' };
  if (!chatReady()) return { ok: false, error: 'janela do DeepSeek nao existe.' };

  busyNavigation = true;
  try {
    persistActiveChatState();
    projects.setActiveChat(projectId, uuid);
    resetReadCache();
    loadChatStateIntoMemory(projectId, uuid);
    activeProjectId = projectId;
    activeChatUuid = uuid;

    const chat = projects.getChat(projectId, uuid);
    if (!chat) throw new Error('chat inexistente apos setActiveChat');
    const targetUrl = chat.url || 'https://chat.deepseek.com/';

    try {
      await chatWindow.loadURL(targetUrl);
      await waitChatReady(chatWindow, NAVIGATION_TIMEOUT_MS);
    } catch (e) {
      notifyProjectsChanged();
      return { ok: false, error: 'DeepSeek demorou para responder: ' + e.message, stage: 'waitChatReady' };
    }

    notifyProjectsChanged();
    return { ok: true, state: buildProjectsState(), stats: stats() };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { busyNavigation = false; }
});

ipcMain.handle('projects:openSessionPopup', (event, { uuid, label }) => {
  if (!isNonEmptyString(uuid)) return { ok: false, error: 'uuid invalido' };
  try { return openSessionPopup(uuid, label); }
  catch (e) { return { ok: false, error: e.message }; }
});
// ============================================================
// IPC — history (paginas HTML do chat)
// ============================================================
ipcMain.handle('history:append', (event, { projectId, chatId, entries }) => {
  if (!isNonEmptyString(projectId)) return { ok: false, error: 'projectId invalido' };
  if (!isNonEmptyString(chatId)) return { ok: false, error: 'chatId invalido' };
  if (!Array.isArray(entries)) return { ok: false, error: 'entries invalido' };
  try { return history.append(projectId, chatId, entries); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('history:readLast', (event, { projectId, chatId }) => {
  if (!isNonEmptyString(projectId)) return { entries: [], page: 0, totalPages: 0 };
  if (!isNonEmptyString(chatId)) return { entries: [], page: 0, totalPages: 0 };
  try { return history.readLast(projectId, chatId); }
  catch (e) { return { entries: [], page: 0, totalPages: 0 }; }
});

ipcMain.handle('history:readPage', (event, { projectId, chatId, page }) => {
  if (!isNonEmptyString(projectId)) return { entries: [], page: 0, totalPages: 0 };
  if (!isNonEmptyString(chatId)) return { entries: [], page: 0, totalPages: 0 };
  if (typeof page !== 'number' || !Number.isFinite(page) || page < 1) {
    return { entries: [], page: 0, totalPages: 0 };
  }
  try { return history.readPage(projectId, chatId, page); }
  catch (e) { return { entries: [], page: 0, totalPages: 0 }; }
});
// ============================================================
// IPC — stats / diagnose
// ============================================================
ipcMain.handle('agent:stats', () => statsLive());

ipcMain.handle('agent:diagnose', async () => {
  if (!chatReady()) return 'ERRO: janela do DeepSeek nao existe.';
  try {
    const wc = chatWindow.webContents;
    const url = wc.getURL();
    const ready = !wc.isLoading();
    const visible = chatWindow.isVisible();
    const textareaCount = await wc.executeJavaScript("document.querySelectorAll('textarea').length");
    const placeholder = await wc.executeJavaScript("(function() { var t = document.querySelector('textarea'); return t ? t.placeholder : 'NENHUM'; })()");
    const inputFound = await wc.executeJavaScript("!!document.querySelector('textarea[placeholder*=\"Mensagem para DeepSeek\" i], textarea')");
    const hasLogin = await wc.executeJavaScript("!!document.querySelector('input[type=\"password\"]')");

    return [
      'URL: ' + url,
      'Carregada: ' + ready,
      'Visivel: ' + visible,
      'Tem login: ' + hasLogin,
      'Textareas: ' + textareaCount,
      'Placeholder: ' + placeholder,
      'Input encontrado: ' + inputFound,
      'deepSeekReady flag: ' + deepSeekReady,
      'running: ' + running,
      'busyNavigation: ' + busyNavigation,
      'projeto ativo: ' + activeProjectId,
      'chat ativo: ' + activeChatUuid,
      'comandos RUN aprovados neste projeto: ' + runAllowlist.size,
      'OK'
    ].join('\n');
  } catch (e) { return 'ERRO: ' + e.message; }
});

ipcMain.handle('agent:disableDeepSeekFeatures', async () => {
  if (!chatReady()) return { ok: false, error: 'janela do DeepSeek nao existe' };
  try { disableDeepSeekFeatures(chatWindow); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ============================================================
// GIT (somente local)
// ============================================================
ipcMain.handle('git:status', async (event, { projectRoot, slug }) => {
  const none = { state: 'none', current: '', expected: '' };
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) return none;
  if (typeof slug !== 'string' || !slug.trim()) return none;
  try { return await gitguard.gitStatus(projectRoot, slug); }
  catch (e) { return none; }
});

ipcMain.handle('git:createBranch', async (event, { projectRoot, slug }) => {
  if (running) return { ok: false, error: 'existe uma tarefa em andamento. Aguarde ou clique em Parar.' };
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) return { ok: false, error: 'projectRoot vazio' };
  if (typeof slug !== 'string' || !slug.trim()) return { ok: false, error: 'slug vazio' };
  try { return await gitguard.createBranch(projectRoot, slug); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('git:commit', async (event, { projectRoot, slug, files, task }) => {
  if (running) return { ok: false, error: 'existe uma tarefa em andamento. Aguarde ou clique em Parar.' };
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) return { ok: false, error: 'projectRoot vazio' };
  if (typeof slug !== 'string' || !slug.trim()) return { ok: false, error: 'slug vazio' };
  try { return await gitguard.commitFiles(projectRoot, slug, files, String(task || '')); }
  catch (e) { return { ok: false, error: e.message }; }
});

// ============================================================
// ABORT
// ============================================================
ipcMain.handle('agent:abort', async () => {
  if (!running) return { ok: false, error: 'nenhuma tarefa em andamento' };
  abortRequested = true;
  if (chatReady()) { try { requestAbort(chatWindow); } catch (e) {} }
  try {
    const n = killActiveProcesses();
    if (n > 0) console.log('[main] abort: ' + n + ' processo(s) RUN morto(s)');
  } catch (e) {}
  return { ok: true };
});

// ============================================================
// syncPendingChat — troca placeholder por UUID real + rename remoto
//
// Chamado no onFirstReply (logo apos a primeira resposta) e como
// fallback no fim do run e no fim do compact (quando ph foi criado).
// Idempotente: se ja foi trocado, uuid === activeChatUuid e a funcao
// retorna sem fazer nada.
// ============================================================
async function syncPendingChat(sendLog) {
  const wasPending = typeof activeChatUuid === 'string' && activeChatUuid.indexOf('pending-') === 0;
  try {
    const currentUrl = chatWindow.webContents.getURL();
    const uuid = projects.extractChatIdFromUrl(currentUrl);
    if (uuid && uuid !== activeChatUuid) {
      if (wasPending) {
        const existing = projects.getChat(activeProjectId, uuid);
        const pendingChat = projects.getChat(activeProjectId, activeChatUuid);
        const pendingLabel = (pendingChat && pendingChat.label) ? pendingChat.label : null;
        const label = existing ? existing.label : (pendingLabel || nextSessionLabel(activeProjectId));
        const oldPendingUuid = activeChatUuid;
        projects.replaceChat(activeProjectId, activeChatUuid, uuid, currentUrl, label);
        activeChatUuid = uuid;
        try { history.renameChat(activeProjectId, oldPendingUuid, uuid); } catch (e) { sendLog('[main] history.renameChat falhou: ' + e.message); }
        sendLog('[main] placeholder substituido por chat real: ' + uuid);
        try { persistActiveChatState(); } catch (e) {}

        const realChat = projects.getChat(activeProjectId, activeChatUuid);
        if (realChat && realChat.label) {
          try {
            const rr = await renameChatRemote(activeChatUuid, realChat.label);
            sendLog('[main] rename remoto RAW: status=' + (rr && rr.status) + ' body=' + (rr && (rr.text || rr.error)));
            notifyProjectsChanged();
            if (rr && rr.ok) {
              sendLog('[main] rename remoto OK: ' + realChat.label);
              try {
                if (chatReady()) {
                  await chatWindow.webContents.reload();
                  await waitChatReady(chatWindow, NAVIGATION_TIMEOUT_MS);
                  sendLog('[main] chat recarregado para atualizar o titulo');
                }
              } catch (e) {
                sendLog('[main] reload apos rename falhou: ' + e.message);
              }
            } else {
              sendLog('[main] rename remoto FALHOU: ' + (rr && (rr.text || rr.error) || 'erro'));
            }
          } catch (e) {
            sendLog('[main] rename remoto excecao: ' + e.message);
          }
        }
        notifyProjectsChanged();
      } else {
        const existing = projects.getChat(activeProjectId, uuid);
        const label = existing ? existing.label : projects.uuidShort(uuid);
        const chat = projects.addChat(activeProjectId, uuid, currentUrl, label);
        activeChatUuid = chat.uuid;
        notifyProjectsChanged();
      }
    }
  } catch (e) { /* ignora */ }
}

// ============================================================
// RUN
// ============================================================
ipcMain.handle('agent:run', async (event, { task, projectRoot }) => {
  const sendLog = (msg) => { try { event.sender.send('agent:log', msg); } catch (e) {} };
  const sendCommand = (cmd) => { try { event.sender.send('agent:command', cmd); } catch (e) {} };
  const sendResult = (r) => { try { event.sender.send('agent:result', r); } catch (e) {} };
  const sendStream = (text) => { try { event.sender.send('agent:stream', { text: text }); } catch (e) {} };
  const sendTurn = (turnLog) => { currentTurnLog = turnLog; try { event.sender.send('agent:stats', statsLive()); } catch (e) {} };

  if (typeof task !== 'string' || !task.trim()) return { ok: false, error: 'task vazia', stats: stats() };
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) return { ok: false, error: 'projectRoot vazio', stats: stats() };

  if (running) return { ok: false, error: 'ja existe uma tarefa em andamento. Aguarde ou clique em Parar.', stats: stats() };
  if (busyNavigation) return { ok: false, error: 'existe uma operacao em andamento. Aguarde.', stats: stats() };
  if (!chatReady()) return { ok: false, error: 'janela do DeepSeek nao existe. Reinicie o app.', stats: stats() };
  if (!activeProjectId) return { ok: false, error: 'nenhum projeto ativo. Crie um projeto primeiro.', stats: stats() };

  // Guarda de branch: se a branch do projeto existe e a atual e outra, pergunta antes de rodar.
  try {
    const gp = projects.getProject(activeProjectId);
    const gs = (gp && gp.slug) ? await gitguard.gitStatus(projectRoot, gp.slug) : null;
    if (gs && gs.state === 'wrongbranch') {
      const mbOpts = {
        type: 'warning',
        buttons: ['Cancelar', 'Continuar mesmo assim'],
        defaultId: 0,
        cancelId: 0,
        title: 'Branch diferente',
        message: 'Voce esta na branch "' + gs.current + '" e nao na "' + gs.expected + '".',
        detail: 'As alteracoes do agente serao feitas na branch atual.',
      };
      const gr = (win && !win.isDestroyed())
        ? await dialog.showMessageBox(win, mbOpts)
        : await dialog.showMessageBox(mbOpts);
      if (gr.response !== 1) {
        return { ok: false, error: 'Tarefa cancelada: branch atual "' + gs.current + '" (esperada: "' + gs.expected + '").', stats: stats() };
      }
    }
  } catch (e) { sendLog('[main] guarda de branch falhou: ' + e.message); }

  // Descarta comandos expirados/sem timestamp antes de rodar.
  try { pruneRunAllowlist(); } catch (e) {}

  if (!activeChatUuid) {
    const ph = createPendingChat();
    if (!ph) return { ok: false, error: 'falha ao criar placeholder', stats: stats() };
    sendLog('[main] run: placeholder criado on-the-fly: ' + ph);
  }

  const wasPending = typeof activeChatUuid === 'string' && activeChatUuid.indexOf('pending-') === 0;

  try { pruneSessionLog(sessionLog); } catch (e) {}

  currentRunId++;
  const myRunId = currentRunId;
  running = true;
  abortRequested = false;
  resetAbortFlag();
  currentTurnLog = [];
  const startedAt = Date.now();

  const watchdog = setTimeout(() => {
    if (myRunId !== currentRunId) return;
    if (running) {
      running = false;
      sendLog('⚠️ WATCHDOG: tarefa travada por mais de ' + Math.round(RUN_HARD_TIMEOUT_MS / 60000) + 'min. Estado resetado.');
    }
  }, RUN_HARD_TIMEOUT_MS);

  sendLog('[main] agent:run iniciado (projeto=' + activeProjectId + ', chat=' + activeChatUuid + ')');

  if (chatReady() && chatWindow.isVisible()) chatWindow.webContents.focus();

  try {
    const result = await runAgent({
      task, projectRoot, chatView: chatWindow, sessionLog,
      needsPreload: (tasksCount === 0 && lastSummary.length > 0),
      onLog: sendLog, onCommand: sendCommand, onResult: sendResult, onTurn: sendTurn, onStream: sendStream,
      shouldAbort: () => abortRequested,
      confirmRunBatch: confirmRunBatch,
      runAllowlist: runAllowlist,
      onAlwaysAllow: addToRunAllowlist,
      onFirstReply: function () { return syncPendingChat(sendLog); },
    });

    if (win && !win.isDestroyed()) win.webContents.focus();

    if (Array.isArray(result.turnLog)) {
      for (const msg of result.turnLog) {
        if (msg && (msg.role === 'user' || msg.role === 'assistant')) sessionLog.push(msg);
      }
    }

    tasksCount++;

    // Fallback: se o onFirstReply nao conseguiu trocar (ex.: URL ainda nao
    // tinha o uuid), tenta de novo aqui. Idempotente.
    await syncPendingChat(sendLog);

    persistActiveChatState();
    persistRunAllowlist();

    currentTurnLog = null;
    try { pruneSessionLog(sessionLog); } catch (e) {}
    notifyProjectsChanged();

    return {
      ok: true,
      result: {
        ...result,
        needsReview: !!result.needsReview,
        touchedFiles: Array.isArray(result.touchedFiles) ? result.touchedFiles : [],
        reviewPrompt: typeof result.reviewPrompt === 'string' ? result.reviewPrompt : '',
      },
      stats: statsAfterRun(),
      state: buildProjectsState(),
    };
  } catch (err) {
    if (win && !win.isDestroyed()) win.webContents.focus();
    sendLog('[main] ERRO: ' + err.message);
    console.error('[main] STACK COMPLETO:', err.stack || err);
    // ITEM 19b: preserva turnLog acumulado no erro (mesmo destino do
    // caminho de sucesso: sessionLog). Apenas o push, sem persistActiveChatState.
    if (err && Array.isArray(err.turnLog)) {
      for (const msg of err.turnLog) {
        if (msg && (msg.role === 'user' || msg.role === 'assistant')) sessionLog.push(msg);
      }
    }
    currentTurnLog = null;
    return { ok: false, error: err.message, stats: statsAfterRun() };
  } finally {
    clearTimeout(watchdog);
    if (myRunId === currentRunId) {
      running = false;
      abortRequested = false;
      currentTurnLog = null;
      resetAbortFlag();
    }
  }
});

// ============================================================
// COMPACT
// ============================================================
ipcMain.handle('agent:compact', async (event) => {
  const sendLog = (msg) => { try { event.sender.send('agent:log', msg); } catch (e) {} };
  sendLog('[main] agent:compact solicitado');

  if (running) return { ok: false, error: 'existe uma tarefa em andamento.', stats: stats() };
  if (busyNavigation) return { ok: false, error: 'existe uma operacao em andamento.', stats: stats() };
  if (!sessionLog.length) return { ok: false, error: 'sessão vazia.', stats: stats() };
  if (!chatReady()) return { ok: false, error: 'janela do DeepSeek nao existe.', stats: stats() };
  if (!activeProjectId) return { ok: false, error: 'nenhum projeto ativo.', stats: stats() };

  const backup = {
    sessionLog: sessionLog.slice(),
    tasksCount: tasksCount,
    lastSummary: lastSummary,
    activeChatUuid: activeChatUuid,
  };

  currentRunId++;
  const myRunId = currentRunId;
  running = true;
  abortRequested = false;
  resetAbortFlag();

  const watchdog = setTimeout(() => {
    if (myRunId !== currentRunId) return;
    if (running) { running = false; sendLog('⚠️ WATCHDOG: compactacao travada.'); }
  }, 10 * 60 * 1000);

  if (chatReady() && chatWindow.isVisible()) chatWindow.webContents.focus();

  try {
    const result = await compactSession({
      chatView: chatWindow, sessionLog, onLog: sendLog,
      shouldAbort: () => abortRequested,
    });

    if (win && !win.isDestroyed()) win.webContents.focus();

    lastSummary = result.summary;
    resetReadCache();
    sessionLog = result.newSessionLog;
    tasksCount = 0;
    runAllowlist.clear();
    persistRunAllowlist();

    if (result && result.chatWasReset) {
      try {
        persistActiveChatState();
        const ph = createPendingChat();
        if (ph) {
          sendLog('[main] compact: chat resetado, novo placeholder: ' + ph);
          try {
            projects.updateChatState(activeProjectId, ph, {
              sessionLog: sessionLog, tasksCount: 0, lastSummary: lastSummary,
            });
          } catch (e) {}
          await syncPendingChat(sendLog);
        } else {
          sendLog('[main] compact: chat resetado mas nao foi possivel criar placeholder');
          activeChatUuid = null;
        }
      } catch (e) {
        sendLog('[main] compact: falha ao registrar reset (' + e.message + ')');
        activeChatUuid = null;
      }
    } else {
      persistActiveChatState();
    }

    notifyProjectsChanged();
    return { ok: true, stats: statsAfterRun() };
  } catch (err) {
    if (win && !win.isDestroyed()) win.webContents.focus();

    if (err && err.resetDone) {
      sessionLog = []; tasksCount = 0; lastSummary = '';
      runAllowlist.clear();
      persistRunAllowlist();
      persistActiveChatState();
      try { const ph = createPendingChat(); if (!ph) activeChatUuid = null; }
      catch (e) { activeChatUuid = null; }
      notifyProjectsChanged();
      return { ok: false, error: 'Compactacao falhou apos resetar: ' + err.message, stats: statsAfterRun() };
    }

    sessionLog = backup.sessionLog;
    tasksCount = backup.tasksCount;
    lastSummary = backup.lastSummary;
    activeChatUuid = backup.activeChatUuid;
    sendLog('compact: falhou antes do reset (' + err.message + '). Sessao restaurada.');
    return { ok: false, error: err.message, stats: statsAfterRun() };
  } finally {
    clearTimeout(watchdog);
    if (myRunId === currentRunId) { running = false; abortRequested = false; resetAbortFlag(); }
  }
});

// ============================================================
// RESET SESSION (compat)
// ============================================================
ipcMain.handle('agent:resetSession', async (event) => {
  if (running) return { ok: false, error: 'existe uma tarefa em andamento.', stats: stats() };
  sessionLog = []; tasksCount = 0; lastSummary = '';
  abortRequested = false;
  runAllowlist.clear();
  currentTurnLog = null;
  persistRunAllowlist(); persistActiveChatState(); notifyProjectsChanged();
  return { ok: true, stats: stats() };
});

// ============================================================
// BOOT
// ============================================================
async function waitChatReadyOrLogin() {
  try {
    await waitChatReady(chatWindow, BOOT_TIMEOUT_MS);
    return;
  } catch (e) {
    if (e && e.message === 'ABORTED_BY_USER') throw e;
    if (!chatReady()) throw e;
  }
  splashStatus('Faça login no DeepSeek na janela que abriu…');
  try { chatWindow.show(); chatWindow.focus(); } catch (e) {}
  await waitChatReady(chatWindow, LOGIN_TIMEOUT_MS);
  try { chatWindow.hide(); } catch (e) {}
}

async function appBoot() {
  if (!win || win.isDestroyed()) return;
  splashStatus('Iniciando Agente DeepSeek…');
  try {
    splashStatus('Carregando projetos…');
    projects.init(app.getPath('userData'));
    try { history.init(app.getPath('userData')); } catch (e) { console.warn('[main] history.init falhou:', e.message); }
    applyActiveState();
    splashStatus('Abrindo DeepSeek…');
    createChatWindow();
    if (!chatReady()) throw new Error('janela do DeepSeek nao foi criada');
    splashStatus('Conectando ao DeepSeek…');
    await waitChatReadyOrLogin();
    onBootSuccess();
  } catch (e) {
    console.error('[main] appBoot falhou:', e.message);
    splashError('Falha ao iniciar: ' + e.message);
  }
}

function onBootSuccess() {
  closeSplash();
  if (win && !win.isDestroyed()) {
    win.show(); win.focus();
    try { win.webContents.send('app:ready', { ok: true }); } catch (e) {}
  }
}

ipcMain.on('app:retryBoot', async () => {
  splashStatus('Tentando novamente…');
  try {
    if (!chatReady()) createChatWindow();
    if (!chatReady()) throw new Error('janela do DeepSeek nao foi criada');
    await waitChatReadyOrLogin();
    onBootSuccess();
  } catch (e) { splashError('Falha ao iniciar: ' + e.message); }
});

// ============================================================
// APP LIFECYCLE
// ============================================================
process.on('uncaughtException', (err) => { console.error('ERRO NO MAIN:', err); });
process.on('unhandledRejection', (err) => { console.error('PROMISE NAO TRATADA:', err); });

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createSplashWindow();
  createAgentWindow();
  appBoot();
});

app.on('before-quit', () => {
  isQuitting = true;
  try { persistActiveChatState(); persistRunAllowlist(); projects.flush(); } catch (e) {}
  SUCCEEDED_THIS_SESSION.clear();
  saveWindowState();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});