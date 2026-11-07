// agent/history.js
//
// Persiste o historico visual (HTML ja sanitizado) de cada sessao em
// paginas de arquivo, fora do projects.json.
//
// Estrutura em disco:
//   <userData>/history/<projectId>/<chatId>/
//     page-0001.jsonl
//     page-0002.jsonl
//     ...
//     index.json = { pages: N, lastPageCount: M }
//
// Cada linha de page-NNNN.jsonl e' uma entrada JSON:
//   { t: number, kind: 'user'|'assistant'|'event'|'system', html: string }
//
// Este modulo NAO depende de Electron: recebe o diretorio userData em init().
// Todas as funcoes envolvem I/O em try/catch e NUNCA lancam:
// devolvem { ok:false, error } ou valores vazios.

const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 20;
const MAX_HTML_CHARS = 200000;
const TRUNC_MARKER = '\n[truncado]';

const VALID_KINDS = new Set(['user', 'assistant', 'event', 'system']);

let DATA_DIR = null;

function nowMs() { return Date.now(); }

// Mantem [A-Za-z0-9_-] e troca o resto por "_". Se ficar vazio,
// devolve "_" para nao gerar pasta vazia.
function sanitizeId(id) {
  if (typeof id !== 'string' || id.length === 0) return '_';
  const s = id.replace(/[^A-Za-z0-9_-]/g, '_');
  return s.length > 0 ? s : '_';
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function chatDir(projectId, chatId) {
  if (!DATA_DIR) return null;
  return path.join(DATA_DIR, 'history', sanitizeId(projectId), sanitizeId(chatId));
}

function projectDir(projectId) {
  if (!DATA_DIR) return null;
  return path.join(DATA_DIR, 'history', sanitizeId(projectId));
}

function indexPath(dir) {
  return path.join(dir, 'index.json');
}

function pagePath(dir, page) {
  const n = String(page).padStart(4, '0');
  return path.join(dir, 'page-' + n + '.jsonl');
}

function emptyResult() {
  return { entries: [], page: 0, totalPages: 0 };
}

// ============================================================
// index.json
// ============================================================
function readIndex(dir) {
  const def = { pages: 0, lastPageCount: 0 };
  try {
    const raw = fs.readFileSync(indexPath(dir), 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return def;
    const pages = (typeof obj.pages === 'number' && Number.isFinite(obj.pages) && obj.pages >= 0)
      ? Math.floor(obj.pages) : 0;
    const lastPageCount = (typeof obj.lastPageCount === 'number' && Number.isFinite(obj.lastPageCount) && obj.lastPageCount >= 0)
      ? Math.floor(obj.lastPageCount) : 0;
    return { pages: pages, lastPageCount: lastPageCount };
  } catch (e) {
    return def;
  }
}

function writeIndex(dir, idx) {
  try {
    ensureDir(dir);
    const main = indexPath(dir);
    const tmp = main + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf8');
    fs.renameSync(tmp, main);
    return true;
  } catch (e) {
    return false;
  }
}

// ============================================================
// Entradas
// ============================================================
function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind;
  if (!VALID_KINDS.has(kind)) return null;
  let html = (typeof raw.html === 'string') ? raw.html : '';
  if (html.length > MAX_HTML_CHARS) {
    html = html.slice(0, MAX_HTML_CHARS) + TRUNC_MARKER;
  }
  const t = (typeof raw.t === 'number' && Number.isFinite(raw.t)) ? raw.t : nowMs();
  return { t: t, kind: kind, html: html };
}

// ============================================================
// append
// ============================================================
function append(projectId, chatId, entries) {
  if (typeof projectId !== 'string' || !projectId) return { ok: false, error: 'projectId invalido' };
  if (typeof chatId !== 'string' || !chatId) return { ok: false, error: 'chatId invalido' };
  if (!Array.isArray(entries) || entries.length === 0) return { ok: true, written: 0 };

  const dir = chatDir(projectId, chatId);
  if (!dir) return { ok: false, error: 'history.init() nao foi chamado' };

  let written = 0;

  try {
    ensureDir(dir);
    const idx = readIndex(dir);

    for (const raw of entries) {
      const e = sanitizeEntry(raw);
      if (!e) continue;

      // Abre nova pagina quando a atual esta cheia (ou quando ainda
      // nao existe nenhuma).
      if (idx.pages === 0) {
        idx.pages = 1;
        idx.lastPageCount = 0;
      }
      if (idx.lastPageCount >= PAGE_SIZE) {
        idx.pages += 1;
        idx.lastPageCount = 0;
      }

      const line = JSON.stringify(e) + '\n';
      fs.appendFileSync(pagePath(dir, idx.pages), line, 'utf8');
      idx.lastPageCount += 1;
      written++;
    }

    writeIndex(dir, idx);
    return { ok: true, written: written };
  } catch (e) {
    // Aborta o lote no primeiro erro de I/O, mas devolve o que ja foi
    // escrito pra o caller saber o estado real da pagina.
    return { ok: false, error: e.message, written: written };
  }
}

// ============================================================
// Leitura
// ============================================================
function readPageFile(file) {
  const out = [];
  let skipped = 0;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line || !line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && VALID_KINDS.has(obj.kind) && typeof obj.html === 'string') {
          out.push({ t: obj.t, kind: obj.kind, html: obj.html });
        } else {
          skipped++;
        }
      } catch (e) {
        skipped++;
      }
    }
  } catch (e) { /* arquivo nao existe: devolve vazio */ }
  return { entries: out, skipped: skipped };
}

function readPage(projectId, chatId, page) {
  if (typeof projectId !== 'string' || !projectId) return emptyResult();
  if (typeof chatId !== 'string' || !chatId) return emptyResult();
  if (typeof page !== 'number' || !Number.isFinite(page) || page < 1) return emptyResult();

  const dir = chatDir(projectId, chatId);
  if (!dir) return emptyResult();

  try {
    const idx = readIndex(dir);
    if (idx.pages === 0) return emptyResult();
    const p = Math.floor(page);
    if (p > idx.pages) return { entries: [], page: p, totalPages: idx.pages };
    const res = readPageFile(pagePath(dir, p));
    return { entries: res.entries, page: p, totalPages: idx.pages };
  } catch (e) {
    return emptyResult();
  }
}

function readLast(projectId, chatId) {
  if (typeof projectId !== 'string' || !projectId) return emptyResult();
  if (typeof chatId !== 'string' || !chatId) return emptyResult();

  const dir = chatDir(projectId, chatId);
  if (!dir) return emptyResult();

  try {
    const idx = readIndex(dir);
    if (idx.pages === 0) return emptyResult();
    const res = readPageFile(pagePath(dir, idx.pages));
    return { entries: res.entries, page: idx.pages, totalPages: idx.pages };
  } catch (e) {
    return emptyResult();
  }
}

// ============================================================
// Rename / delete
// ============================================================
function renameChat(projectId, oldChatId, newChatId) {
  if (typeof projectId !== 'string' || !projectId) return { ok: false, error: 'projectId invalido' };
  if (typeof oldChatId !== 'string' || !oldChatId) return { ok: false, error: 'oldChatId invalido' };
  if (typeof newChatId !== 'string' || !newChatId) return { ok: false, error: 'newChatId invalido' };
  if (!DATA_DIR) return { ok: false, error: 'history.init() nao foi chamado' };

  const oldDir = chatDir(projectId, oldChatId);
  const newDir = chatDir(projectId, newChatId);
  if (!oldDir || !newDir) return { ok: false, error: 'history.init() nao foi chamado' };

  if (sanitizeId(oldChatId) === sanitizeId(newChatId)) return { ok: true, renamed: false };

  try {
    if (!fs.existsSync(oldDir)) return { ok: true, renamed: false };
    if (fs.existsSync(newDir)) return { ok: false, error: 'pasta de destino ja existe' };
    fs.renameSync(oldDir, newDir);
    return { ok: true, renamed: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function deleteChat(projectId, chatId) {
  if (typeof projectId !== 'string' || !projectId) return { ok: false, error: 'projectId invalido' };
  if (typeof chatId !== 'string' || !chatId) return { ok: false, error: 'chatId invalido' };

  const dir = chatDir(projectId, chatId);
  if (!dir) return { ok: false, error: 'history.init() nao foi chamado' };

  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function deleteProject(projectId) {
  if (typeof projectId !== 'string' || !projectId) return { ok: false, error: 'projectId invalido' };

  const dir = projectDir(projectId);
  if (!dir) return { ok: false, error: 'history.init() nao foi chamado' };

  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================================
// init
// ============================================================
function init(userDataDir) {
  DATA_DIR = userDataDir;
  try {
    ensureDir(path.join(DATA_DIR, 'history'));
  } catch (e) { /* ignora */ }
  return { ok: true };
}

module.exports = {
  init,
  append,
  readPage,
  readLast,
  renameChat,
  deleteChat,
  deleteProject,
  PAGE_SIZE,
  MAX_HTML_CHARS,
};