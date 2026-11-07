// agent/projects.js
//
// Gerenciador de projetos e chats.
// Persiste em <userData>/projects.json (escrita atomica .tmp + rename,
// com backup .bak). Todo dado "de projeto" (nome, pasta, runAllowlist,
// runAllowlistTs) vive no projeto; todo dado "de conversa" (sessionLog,
// tasksCount, lastSummary) vive no chat.
//
// Este modulo NAO depende de Electron: recebe o diretorio userData em init().
//
// Modelo de um chat:
//   {
//     uuid, url, label, createdAt, lastUsedAt,
//     sessionLog: [ { role, content, chars } ],
//     tasksCount: number,
//     lastSummary: string
//   }
//
// Modelo de um projeto:
//   {
//     id, name, projectRoot, createdAt,
//     activeChatUuid: string|null,
//     runAllowlist: string[],
//     runAllowlistTs: Record<string, number>,
//     chats: Chat[]
//   }

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'projects.json';
const BACKUP_NAME = 'projects.json.bak';
const TMP_SUFFIX = '.tmp';
const SCHEMA_VERSION = 1;

let DATA_DIR = null;
let cache = null;
let dirty = false;
let saveTimer = null;

function nowMs() { return Date.now(); }

function shortId() {
  return 'proj-' + nowMs().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function uuidShort(uuid) {
  if (typeof uuid !== 'string') return '';
  return uuid.replace(/-/g, '').slice(0, 12);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ============================================================
// Substitui um chat placeholder ("pending-...") pelo UUID real
// apos a primeira tarefa.
// ============================================================
function replaceChat(projectId, oldUuid, newUuid, newUrl, newLabel) {
  const p = getProject(projectId);
  if (!p) throw new Error('projeto inexistente');
  if (!newUuid || typeof newUuid !== 'string') throw new Error('newUuid vazio');

  const existing = p.chats.find(function (c) { return c.uuid === newUuid; });
  if (existing) {
    if (newUrl) existing.url = newUrl;
    if (newLabel) existing.label = newLabel;
    existing.lastUsedAt = nowMs();
    p.activeChatUuid = existing.uuid;
    if (oldUuid && oldUuid !== newUuid) {
      const idx = p.chats.findIndex(function (c) { return c.uuid === oldUuid; });
      if (idx !== -1) p.chats.splice(idx, 1);
    }
    scheduleSave();
    return existing;
  }

  const old = oldUuid ? p.chats.find(function (c) { return c.uuid === oldUuid; }) : null;

  const c = makeEmptyChat(newUuid, newUrl, newLabel);
  if (old) {
    c.createdAt = old.createdAt;
    c.sessionLog = Array.isArray(old.sessionLog) ? old.sessionLog : [];
    c.tasksCount = Number.isFinite(old.tasksCount) ? old.tasksCount : 0;
    c.lastSummary = typeof old.lastSummary === 'string' ? old.lastSummary : '';
    const idx = p.chats.findIndex(function (x) { return x.uuid === oldUuid; });
    if (idx !== -1) p.chats.splice(idx, 1);
  }

  p.chats.push(c);
  p.activeChatUuid = c.uuid;
  scheduleSave();
  return c;
}

// ============================================================
// Parsing de URL -> UUID do chat
// ============================================================
function extractChatIdFromUrl(url) {
  if (typeof url !== 'string' || !url) return null;

  let m = url.match(/\/a\/chat\/s\/([A-Za-z0-9_-]{6,64})/);
  if (m) return m[1];

  m = url.match(/\/a\/chat\/([A-Za-z0-9_-]{6,64})/);
  if (m) return m[1];

  m = url.match(/[?&](?:chat|chat_id|chatId|session)=([A-Za-z0-9_-]{6,64})/);
  if (m) return m[1];

  return null;
}

// ============================================================
// Estado default
// ============================================================
function makeEmptyProject(name, projectRoot, slug) {
  return {
    id: shortId(),
    name: String(name || 'Novo projeto'),
    slug: String(slug || '').trim() || slugifyLocal(name),
    projectRoot: String(projectRoot || ''),
    createdAt: nowMs(),
    activeChatUuid: null,
    runAllowlist: [],
    runAllowlistTs: {},
    chats: [],
  };
}

function slugifyLocal(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'projeto';
}

function makeEmptyData() {
  return {
    version: SCHEMA_VERSION,
    activeProjectId: null,
    projects: [],
  };
}

function makeEmptyChat(uuid, url, label) {
  return {
    uuid: String(uuid),
    url: String(url || ('https://chat.deepseek.com/a/chat/s/' + uuid)),
    label: String(label || uuidShort(uuid)),
    createdAt: nowMs(),
    lastUsedAt: nowMs(),
    sessionLog: [],
    tasksCount: 0,
    lastSummary: '',
  };
}

// ============================================================
// Sanitizacao defensiva
// ============================================================
function sanitizeChat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.uuid !== 'string' || !raw.uuid) return null;
  const c = makeEmptyChat(raw.uuid, raw.url, raw.label);
  if (typeof raw.createdAt === 'number') c.createdAt = raw.createdAt;
  if (typeof raw.lastUsedAt === 'number') c.lastUsedAt = raw.lastUsedAt;
  if (Array.isArray(raw.sessionLog)) {
    c.sessionLog = raw.sessionLog
      .filter(function (m) { return m && typeof m === 'object'; })
      .map(function (m) {
        return {
          role: String(m.role || ''),
          content: String(m.content || ''),
          chars: typeof m.chars === 'number' ? m.chars : String(m.content || '').length,
        };
      });
  }
  if (typeof raw.tasksCount === 'number') c.tasksCount = raw.tasksCount;
  if (typeof raw.lastSummary === 'string') c.lastSummary = raw.lastSummary;
  return c;
}

function sanitizeProject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const p = makeEmptyProject(raw.name, raw.projectRoot);
  if (typeof raw.id === 'string' && raw.id) p.id = raw.id;
  if (typeof raw.slug === 'string' && raw.slug) p.slug = raw.slug;
  if (typeof raw.createdAt === 'number') p.createdAt = raw.createdAt;
  if (typeof raw.activeChatUuid === 'string') p.activeChatUuid = raw.activeChatUuid;
  if (Array.isArray(raw.runAllowlist)) {
    p.runAllowlist = raw.runAllowlist.filter(function (x) { return typeof x === 'string'; });
  }
  // runAllowlistTs: fallback {} para dados antigos sem o campo.
  if (raw.runAllowlistTs && typeof raw.runAllowlistTs === 'object' && !Array.isArray(raw.runAllowlistTs)) {
    const ts = {};
    for (const k of Object.keys(raw.runAllowlistTs)) {
      const v = raw.runAllowlistTs[k];
      if (typeof k === 'string' && typeof v === 'number' && Number.isFinite(v)) ts[k] = v;
    }
    p.runAllowlistTs = ts;
  }
  if (Array.isArray(raw.chats)) {
    p.chats = raw.chats.map(sanitizeChat).filter(Boolean);
  }
  if (p.activeChatUuid) {
    const exists = p.chats.some(function (c) { return c.uuid === p.activeChatUuid; });
    if (!exists) p.activeChatUuid = p.chats.length > 0 ? p.chats[0].uuid : null;
  } else if (p.chats.length > 0) {
    p.activeChatUuid = p.chats[0].uuid;
  }
  return p;
}

function sanitizeData(raw) {
  const d = makeEmptyData();
  if (!raw || typeof raw !== 'object') return d;
  if (Array.isArray(raw.projects)) {
    d.projects = raw.projects.map(sanitizeProject).filter(Boolean);
  }
  if (typeof raw.activeProjectId === 'string') d.activeProjectId = raw.activeProjectId;
  if (d.activeProjectId) {
    const exists = d.projects.some(function (p) { return p.id === d.activeProjectId; });
    if (!exists) d.activeProjectId = d.projects.length > 0 ? d.projects[0].id : null;
  } else if (d.projects.length > 0) {
    d.activeProjectId = d.projects[0].id;
  }
  return d;
}

// ============================================================
// Load / Save atomicos
// ============================================================
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveImmediate() {
  if (!DATA_DIR || !cache) return;
  ensureDir(DATA_DIR);

  const main = path.join(DATA_DIR, FILE_NAME);
  const bak = path.join(DATA_DIR, BACKUP_NAME);
  const tmp = main + TMP_SUFFIX;

  try {
    const json = JSON.stringify(cache, null, 2);
    fs.writeFileSync(tmp, json, 'utf8');
    if (fs.existsSync(main)) {
      try { fs.copyFileSync(main, bak); } catch (e) { /* ignora */ }
    }
    fs.renameSync(tmp, main);
    dirty = false;
  } catch (e) {
    console.error('[projects] save falhou:', e.message);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    saveTimer = null;
    if (dirty) saveImmediate();
  }, 250);
}

function load() {
  if (!DATA_DIR) throw new Error('projects.init() nao foi chamado');

  ensureDir(DATA_DIR);
  const main = path.join(DATA_DIR, FILE_NAME);
  const bak = path.join(DATA_DIR, BACKUP_NAME);

  let raw = readJsonSafe(main);
  if (!raw) {
    raw = readJsonSafe(bak);
    if (raw) console.warn('[projects] projects.json invalido, usando backup');
  }

  let data = sanitizeData(raw);

  if (data.projects.length === 0) {
    const p = makeEmptyProject('Projeto 01', '');
    data.projects.push(p);
    data.activeProjectId = p.id;
    dirty = true;
  }

  cache = data;
  if (dirty) { saveImmediate(); dirty = false; }
  return cache;
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (dirty) saveImmediate();
}

// ============================================================
// API publica
// ============================================================
function init(userDataDir) {
  DATA_DIR = userDataDir;
  return load();
}

function getAll() {
  if (!cache) load();
  return cache;
}

// ---- projetos ---------------------------------------------
function getProject(projectId) {
  return getAll().projects.find(function (p) { return p.id === projectId; }) || null;
}

function getActiveProject() {
  return getProject(getAll().activeProjectId);
}

function setActiveProject(projectId) {
  const d = getAll();
  const p = getProject(projectId);
  if (!p) throw new Error('projeto inexistente: ' + projectId);
  d.activeProjectId = p.id;
  scheduleSave();
  return p;
}

function listProjects() {
  return getAll().projects.map(function (p) {
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      projectRoot: p.projectRoot,
      createdAt: p.createdAt,
      activeChatUuid: p.activeChatUuid,
      chatCount: p.chats.length,
    };
  });
}

function createProject(opts) {
  const d = getAll();
  const name = (opts && opts.name) || ('Projeto ' + String(d.projects.length + 1).padStart(2, '0'));
  const p = makeEmptyProject(name, (opts && opts.projectRoot) || '', (opts && opts.slug) || '');
  d.projects.push(p);
  d.activeProjectId = p.id;
  scheduleSave();
  return p;
}

function renameProject(projectId, name) {
  const p = getProject(projectId);
  if (!p) throw new Error('projeto inexistente');
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('nome vazio');
  p.name = trimmed;
  scheduleSave();
  return p;
}

function setProjectRoot(projectId, projectRoot) {
  const p = getProject(projectId);
  if (!p) throw new Error('projeto inexistente');
  p.projectRoot = String(projectRoot || '');
  scheduleSave();
  return p;
}

function deleteProject(projectId) {
  const d = getAll();
  const idx = d.projects.findIndex(function (p) { return p.id === projectId; });
  if (idx === -1) throw new Error('projeto inexistente');
  d.projects.splice(idx, 1);
  if (d.activeProjectId === projectId) {
    d.activeProjectId = d.projects.length > 0 ? d.projects[0].id : null;
  }
  scheduleSave();
  return { removed: true, activeProjectId: d.activeProjectId };
}

// ---- chats -------------------------------------------------
function listChats(projectId) {
  const p = getProject(projectId);
  if (!p) return [];
  return p.chats.map(function (c) {
    return {
      uuid: c.uuid,
      label: c.label,
      url: c.url,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
      sessionChars: c.sessionLog.reduce(function (s, m) { return s + (m.chars || 0); }, 0),
      tasksCount: c.tasksCount,
      isActive: p.activeChatUuid === c.uuid,
    };
  });
}

function getChat(projectId, uuid) {
  const p = getProject(projectId);
  if (!p) return null;
  return p.chats.find(function (c) { return c.uuid === uuid; }) || null;
}

function getActiveChat(projectId) {
  const p = getProject(projectId);
  if (!p) return null;
  if (!p.activeChatUuid) return null;
  return p.chats.find(function (c) { return c.uuid === p.activeChatUuid; }) || null;
}

function addChat(projectId, uuid, url, label) {
  const p = getProject(projectId);
  if (!p) throw new Error('projeto inexistente');
  if (typeof uuid !== 'string' || !uuid) throw new Error('uuid vazio');

  const existing = p.chats.find(function (c) { return c.uuid === uuid; });
  if (existing) {
    if (url) existing.url = url;
    if (label) existing.label = label;
    existing.lastUsedAt = nowMs();
    p.activeChatUuid = existing.uuid;
    scheduleSave();
    return existing;
  }

  const c = makeEmptyChat(uuid, url, label);
  p.chats.push(c);
  p.activeChatUuid = c.uuid;
  scheduleSave();
  return c;
}

function renameChat(projectId, uuid, label) {
  const c = getChat(projectId, uuid);
  if (!c) throw new Error('chat inexistente');
  const trimmed = String(label || '').trim();
  if (!trimmed) throw new Error('label vazio');
  c.label = trimmed;
  scheduleSave();
  return c;
}

function setActiveChat(projectId, uuid) {
  const p = getProject(projectId);
  if (!p) throw new Error('projeto inexistente');
  const c = p.chats.find(function (x) { return x.uuid === uuid; });
  if (!c) throw new Error('chat inexistente');
  p.activeChatUuid = c.uuid;
  c.lastUsedAt = nowMs();
  scheduleSave();
  return c;
}

function deleteChat(projectId, uuid) {
  const p = getProject(projectId);
  if (!p) throw new Error('projeto inexistente');
  const idx = p.chats.findIndex(function (c) { return c.uuid === uuid; });
  if (idx === -1) throw new Error('chat inexistente');
  p.chats.splice(idx, 1);
  if (p.activeChatUuid === uuid) {
    p.activeChatUuid = p.chats.length > 0 ? p.chats[0].uuid : null;
  }
  scheduleSave();
  return { removed: true, activeChatUuid: p.activeChatUuid };
}

// ITEM 18: cada entrada e' gravada com content '' e o chars preservado
// (usa o chars existente se vier; senao String(content).length). O
// content continua vivo em memoria ate o momento de persistir.
function updateChatState(projectId, uuid, state) {
  const c = getChat(projectId, uuid);
  if (!c) return null;
  if (state && Array.isArray(state.sessionLog)) {
    c.sessionLog = state.sessionLog.map(function (m) {
      const role = String(m.role || '');
      const content = String(m.content || '');
      const chars = (typeof m.chars === 'number') ? m.chars : content.length;
      return { role: role, content: '', chars: chars };
    });
  }
  if (state && typeof state.tasksCount === 'number') c.tasksCount = state.tasksCount;
  if (state && typeof state.lastSummary === 'string') c.lastSummary = state.lastSummary;
  c.lastUsedAt = nowMs();
  scheduleSave();
  return c;
}

// ---- runAllowlist (por projeto) ---------------------------
function getRunAllowlist(projectId) {
  const p = getProject(projectId);
  if (!p) return [];
  return p.runAllowlist.slice();
}

function setRunAllowlist(projectId, arr) {
  const p = getProject(projectId);
  if (!p) throw new Error('projeto inexistente');
  p.runAllowlist = (Array.isArray(arr) ? arr : []).filter(function (x) {
    return typeof x === 'string' && x.length > 0;
  });
  scheduleSave();
  return p.runAllowlist;
}

function getRunAllowlistTs(projectId) {
  const p = getProject(projectId);
  if (!p) return {};
  return Object.assign({}, p.runAllowlistTs);
}

function setRunAllowlistTs(projectId, obj) {
  const p = getProject(projectId);
  if (!p) throw new Error('projeto inexistente');
  const src = (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  const out = {};
  for (const k of Object.keys(src)) {
    if (typeof k !== 'string' || !k) continue;
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  p.runAllowlistTs = out;
  scheduleSave();
  return p.runAllowlistTs;
}

// ============================================================
// Helpers exportados
// ============================================================
function getChatUrl(uuid) {
  return 'https://chat.deepseek.com/a/chat/s/' + String(uuid || '');
}

module.exports = {
  init,
  load,
  flush,

  getAll,
  listProjects,
  getProject,
  getActiveProject,
  setActiveProject,
  createProject,
  renameProject,
  setProjectRoot,
  deleteProject,

  listChats,
  getChat,
  getActiveChat,
  addChat,
  renameChat,
  setActiveChat,
  deleteChat,
  replaceChat,
  updateChatState,

  getRunAllowlist,
  setRunAllowlist,
  getRunAllowlistTs,
  setRunAllowlistTs,

  extractChatIdFromUrl,
  getChatUrl,
  uuidShort,
};