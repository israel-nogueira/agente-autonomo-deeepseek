// tools.js
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const { parseReadArg } = require('./parser');

let prettier = null;
let phpPlugin = null;
try {
  prettier = require('prettier');
  phpPlugin = require('@prettier/plugin-php');
} catch (e) {
  console.warn('[tools] prettier nao instalado. Formatacao automatica desabilitada.');
  console.warn('[tools] Rode: npm install prettier @prettier/plugin-php');
}

const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'target',
  '__pycache__', '.venv', 'venv', 'coverage', '.cache',
]);

const DIFF_MAX_LINES = 200;

// ============================================================
// READ — limite de linhas por arquivo inteiro
// ============================================================
const MAX_READ_LINES = 2000;

// ============================================================
// MAX_REFS — tamanho do cache LRU de trechos lidos
// ============================================================
const MAX_REFS = 2000;

// ============================================================
// REGISTRO DE PROCESSOS ATIVOS
// ============================================================
const activeChildren = new Set();

function killProcessTree(child, isWin) {
  if (!child || child.killed || !child.pid) return;

  if (isWin) {
    try {
      const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      tk.on('error', () => { /* ignora */ });
    } catch (e) { /* ignora */ }

    try { child.kill(); } catch (e) { /* ignora */ }
  } else {
    try { child.kill('SIGTERM'); } catch (e) { /* ignora */ }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) { /* ignora */ }
    }, 2000);
  }
}

function killActiveProcesses() {
  if (activeChildren.size === 0) return 0;
  const n = activeChildren.size;
  console.log('[tools] killActiveProcesses: matando ' + n + ' processo(s)');

  const isWin = process.platform === 'win32';
  for (const child of Array.from(activeChildren)) {
    if (typeof child.__killByUser === 'function') {
      try { child.__killByUser(); } catch (e) { /* ignora */ }
    } else {
      killProcessTree(child, isWin);
    }
  }
  return n;
}

// ============================================================
// MEMORIA DE TRECHOS LIDOS (para OLD_REF)
// ============================================================
const readCache = new Map();
let refCounter = 0;

function resetReadCache() {
  readCache.clear();
  refCounter = 0;
}

function nextRefId() {
  refCounter++;
  return 'R' + refCounter;
}

function getRef(id) {
  return readCache.get(id);
}

function hashOf(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function putRef(id, obj) {
  readCache.set(id, obj);
  while (readCache.size > MAX_REFS) {
    const firstKey = readCache.keys().next().value;
    readCache.delete(firstKey);
    console.log('[tools] readCache LRU: removido ' + firstKey);
  }
}

// ============================================================
// PATH SAFE
// ============================================================
function makeSafe(root) {
  const rootNorm = path.resolve(root);
  const isWin = process.platform === 'win32';
  const rootCmp = isWin ? rootNorm.toLowerCase() : rootNorm;

  return (p) => {
    const abs = path.resolve(rootNorm, p);
    const absCmp = isWin ? abs.toLowerCase() : abs;

    if (absCmp !== rootCmp && !absCmp.startsWith(rootCmp + path.sep)) {
      throw new Error('caminho fora do projeto: ' + p);
    }
    return abs;
  };
}

// ============================================================
// getFileContent — le o arquivo cru do disco
// ============================================================
async function getFileContent(projectRoot, rel) {
  const safe = makeSafe(projectRoot);
  const abs = safe(rel);
  const content = await fs.readFile(abs, 'utf8');
  const fileName = path.basename(rel);
  return { content, fileName, abs };
}

// ============================================================
// VALIDACAO DE SINTAXE JS
// ============================================================
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function isJsFile(rel) {
  return JS_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

function looksLikeStrippedTemplate(content) {
  const s = String(content);
  if (!s.includes('${')) return false;

  const backticks = s.match(/`/g);
  if (!backticks) return true;
  if (backticks.length % 2 === 1) return true;
  return false;
}

async function validateJsSyntax(rel, content) {
  const tmp = path.join(
    os.tmpdir(),
    'agente-check-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.js'
  );

  try {
    await fs.writeFile(tmp, content, 'utf8');
  } catch (e) {
    return { ok: true };
  }

  try {
    await execFileP('node', ['--check', tmp], { timeout: 10000, encoding: 'utf8' });
    return { ok: true };
  } catch (err) {
    const raw = ((err.stderr || '') + (err.message ? '\n' + err.message : '')).trim();
    const stripped = looksLikeStrippedTemplate(content);
    let errorLine = 0;
    const lm = raw.match(/agente-check[^:]*:(\d+)/);
    if (lm) errorLine = parseInt(lm[1], 10);
    return { ok: false, raw: raw.slice(0, 800), stripped: stripped, content: content, errorLine: errorLine };
  } finally {
    try { await fs.unlink(tmp); } catch (e) { /* ignora */ }
  }
}

function syntaxErrorMessage(type, rel, result) {
  let msg = '<<<RESULT:' + type + ':' + rel + ':SYNTAX_ERROR>>>\n';
  msg += 'Seu conteudo tem erro de sintaxe JS e NAO foi gravado no disco.\n\n';

  if (result.stripped) {
    msg += 'DIAGNOSTICO: parece que as crases (`) dos template literals foram REMOVIDAS pelo renderer do chat web.\n';
    msg += 'O sintoma e: "${" aparece sem "`" antes na mesma linha.\n\n';
    msg += 'NAO use template literals neste ambiente. Use concatenacao com + :\n';
    msg += "  RUIM:  const msg = `Ola ${nome}`;\n";
    msg += "  BOM:   const msg = 'Ola ' + nome;\n";
    msg += "  RUIM:  path.join('dist', `${base}.min.html`);\n";
    msg += "  BOM:   path.join('dist', base + '.min.html');\n\n";
    msg += 'Reescreva o arquivo INTEIRO sem nenhuma crase. Nao tente EDIT nele — pode piorar.\n\n';
  }

  if (result.content && result.errorLine > 0) {
    const lines = String(result.content).split('\n');
    const from = Math.max(0, result.errorLine - 5);
    const to = Math.min(lines.length, result.errorLine + 2);
    msg += 'Contexto do arquivo (ERRO reportado na linha ' + result.errorLine + '):\n';
    for (let i = from; i < to; i++) {
      const marker = (i + 1) === result.errorLine ? ' >>> ' : '     ';
      msg += marker + String(i + 1).padStart(4) + '| ' + lines[i] + '\n';
    }
    msg += '\nDica: o erro real normalmente esta na LINHA ANTERIOR a que o node reporta.\n\n';
  }

  msg += 'Erro do node --check:\n' + result.raw + '\n';
  msg += '<<<END>>>';
  return msg;
}

async function writeOrValidate(abs, rel, content, type) {
  if (isJsFile(rel)) {
    const v = await validateJsSyntax(rel, content);
    if (!v.ok) {
      return { ok: false, msg: syntaxErrorMessage(type, rel, v) };
    }
  }
  await fs.writeFile(abs, content, 'utf8');
  return { ok: true };
}

// ============================================================
// FORMATACAO
// ============================================================
function parserFor(rel) {
  if (rel.endsWith('.html') || rel.endsWith('.htm')) return 'html';
  if (rel.endsWith('.css')) return 'css';
  if (rel.endsWith('.scss')) return 'scss';
  if (rel.endsWith('.less')) return 'less';
  if (rel.endsWith('.js') || rel.endsWith('.mjs') || rel.endsWith('.cjs')) return 'babel';
  if (rel.endsWith('.jsx')) return 'babel';
  if (rel.endsWith('.ts') || rel.endsWith('.tsx')) return 'typescript';
  if (rel.endsWith('.json')) return 'json';
  if (rel.endsWith('.md')) return 'markdown';
  if (rel.endsWith('.yaml') || rel.endsWith('.yml')) return 'yaml';
  if (rel.endsWith('.php')) return 'php';
  return null;
}

async function formatCode(code, rel) {
  if (!prettier) return code;
  const parser = parserFor(rel);
  if (!parser) return code;

  try {
    const plugins = parser === 'php' && phpPlugin ? [phpPlugin] : [];
    const formatted = await prettier.format(code, {
      parser: parser,
      plugins: plugins,
      printWidth: 120,
      tabWidth: 4,
      useTabs: false,
      semi: true,
      singleQuote: true,
      trailingComma: 'es5',
      bracketSpacing: true,
      arrowParens: 'always',
      endOfLine: 'lf',
    });
    return formatted.trim();
  } catch (e) {
    console.warn('[formatCode] falhou para ' + rel + ': ' + e.message);
    return code;
  }
}

// ============================================================
// WALK
// ============================================================
async function walkFiles(root, relDir, out) {
  const abs = path.join(root, relDir || '.');
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    if (DEFAULT_IGNORE.has(e.name)) continue;
    const rel = relDir ? path.join(relDir, e.name) : e.name;
    if (e.isDirectory()) {
      await walkFiles(root, rel, out);
    } else {
      out.push(rel.replace(/\\/g, '/'));
    }
  }
}

// ============================================================
// GREP
// ============================================================
async function grep(safe, root, arg) {
  const idx = arg.indexOf(':');
  if (idx === -1) {
    return { ok: false, msg: '<<<RESULT:GREP:ERROR>>>\nUse GREP:caminho/**:texto ou GREP:arquivo:texto\n<<<END>>>' };
  }
  const target = arg.slice(0, idx).trim();
  const pattern = arg.slice(idx + 1).trim();

  if (!pattern) {
    return { ok: false, msg: '<<<RESULT:GREP:ERROR>>>\npadrao vazio\n<<<END>>>' };
  }

  let re;
  try {
    re = new RegExp(pattern, 'i');
  } catch (e) {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const results = [];
  const maxResults = 100;
  let totalMatches = 0;
  let truncated = false;

  async function searchFile(relPath) {
    try {
      const raw = await fs.readFile(safe(relPath), 'utf8');
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          totalMatches++;
          if (results.length < maxResults) {
            results.push(relPath + ':' + (i + 1) + ':' + lines[i].trim().slice(0, 200));
          } else {
            truncated = true;
          }
        }
      }
    } catch (e) { /* binario */ }
  }

  const isFileTarget = /\.\w+$/.test(target) && target.indexOf('*') === -1;
  if (isFileTarget) {
    try {
      await fs.access(safe(target));
    } catch (e) {
      return { ok: false, msg: '<<<RESULT:GREP:ERROR>>>\narquivo nao encontrado: ' + target + '\n<<<END>>>' };
    }
    await searchFile(target);
  } else {
    const dir = target.replace(/\/\*\*.*$/, '').replace(/\/?\*.*$/, '').replace(/\/$/, '') || '.';
    const files = [];
    await walkFiles(root, dir === '.' ? '' : dir, files);
    if (files.length === 0) {
      return { ok: false, msg: '<<<RESULT:GREP:ERROR>>>\nnenhum arquivo em: ' + dir + '\n<<<END>>>' };
    }
    for (const f of files) {
      if (results.length >= maxResults) { truncated = true; break; }
      await searchFile(f);
    }
  }

  if (results.length === 0) {
    return { ok: true, msg: '<<<RESULT:GREP:' + arg + ':0 matches>>>\n<<<END>>>' };
  }

  let out = '<<<RESULT:GREP:' + arg + ':' + totalMatches + ' matches' + (truncated ? ' (truncado em ' + maxResults + ')' : '') + '>>>\n';
  out += results.join('\n');
  out += '\n<<<END>>>';
  return { ok: true, msg: out };
}

// ============================================================
// GLOB
// ============================================================
async function glob(safe, root, arg) {
  const pattern = arg.trim();
  const files = [];
  await walkFiles(root, '', files);

  const reStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '__DOUBLE_SLASH__')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/__DOUBLE_SLASH__/g, '(?:.*\\/)?')
    .replace(/__DOUBLE_STAR__/g, '.*');

  let re;
  try {
    re = new RegExp('^' + reStr + '$');
  } catch (e) {
    return { ok: false, msg: '<<<RESULT:GLOB:ERROR>>>\npadrao invalido\n<<<END>>>' };
  }

  const matches = files.filter(f => re.test(f)).sort();
  const truncated = matches.length > 200;
  const limited = truncated ? matches.slice(0, 200) : matches;

  if (matches.length === 0) {
    return { ok: true, msg: '<<<RESULT:GLOB:' + pattern + ':0 matches>>>\n<<<END>>>' };
  }

  return { ok: true, msg: '<<<RESULT:GLOB:' + pattern + ':' + matches.length + ' matches' + (truncated ? ' (truncado em 200)' : '') + '>>>\n' + limited.join('\n') + '\n<<<END>>>' };
}

// ============================================================
// READ (com AUTO-DESMINIFICAR)
// ============================================================
async function readFile(safe, arg) {
  const parsed = parseReadArg(arg);
  const rel = parsed.path;
  const start = parsed.start;
  const end = parsed.end;
  const abs = safe(rel);
  let raw = await fs.readFile(abs, 'utf8');

  // AUTO-DESMINIFICAR
  if (raw.length > 5000 && raw.split('\n').length < 5) {
    try {
      const formatted = await formatCode(raw, rel);
      if (formatted && formatted !== raw && formatted.length > raw.length * 0.8) {
        if (formatted.length < raw.length * 1.5) {
          await fs.writeFile(abs, formatted, 'utf8');
          console.log('[tools] auto-desminificado: ' + rel + ' (' + raw.length + ' -> ' + formatted.length + ' bytes)');
          raw = formatted;
        }
      }
    } catch (e) {
      console.warn('[tools] auto-desminificar falhou em ' + rel + ': ' + e.message);
    }
  }

  const lines = raw.split('\n');
  const total = lines.length;
  const fileHash = hashOf(raw);

  if (start === undefined) {
    if (total <= MAX_READ_LINES) {
      const id = nextRefId();
      putRef(id, {
        path: rel,
        start: 1,
        end: total,
        lines: lines,
        hash: fileHash,
        sliceHash: hashOf(lines.join('\n')),
      });
      return formatRead(rel, 1, total, total, lines, id);
    }

    const half = Math.ceil(total / 2);
    const linesA = lines.slice(0, half);
    const linesB = lines.slice(half);

    const refA = nextRefId();
    putRef(refA, {
      path: rel,
      start: 1,
      end: half,
      lines: linesA,
      hash: fileHash,
      sliceHash: hashOf(linesA.join('\n')),
    });

    const refB = nextRefId();
    putRef(refB, {
      path: rel,
      start: half + 1,
      end: total,
      lines: linesB,
      hash: fileHash,
      sliceHash: hashOf(linesB.join('\n')),
    });

    return formatReadMulti(rel, total, half, linesA, linesB, refA, refB);
  }

  const s = Math.max(1, start);
  const e = Math.min(total, end === Infinity ? total : end);
  if (s > total) return { ok: false, msg: '<<<RESULT:READ:' + rel + ':ERROR>>>\nArquivo tem so ' + total + ' linhas.\n<<<END>>>' };
  if (e < s) return { ok: false, msg: '<<<RESULT:READ:' + rel + ':ERROR>>>\nRange invalido: ' + s + '-' + e + '.\n<<<END>>>' };

  const slice = lines.slice(s - 1, e);
  const id = nextRefId();
  putRef(id, {
    path: rel,
    start: s,
    end: e,
    lines: slice,
    hash: fileHash,
    sliceHash: hashOf(slice.join('\n')),
  });

  return formatRead(rel, s, e, total, slice, id);
}

function formatRead(rel, s, e, total, lines, refId) {
  const complete = s === 1 && e === total;
  const header = '<<<RESULT:READ:' + rel + ':' + s + '-' + e + ' of ' + total + (complete ? ' (complete)' : '') + (refId ? ' [' + refId + ']' : '') + '>>>';
  const body = lines.map(function (ln, i) {
    return String(s + i).padStart(4) + '|' + ln;
  }).join('\n');

  const hint = refId
    ? '\n\n[Para editar use <<<OLD_REF:' + refId + ':INICIO-FIM>>> em vez de copiar o OLD.]'
    : '';

  return { ok: true, msg: header + '\n' + body + hint + '\n<<<END>>>' };
}

function formatReadMulti(rel, total, half, linesA, linesB, refA, refB) {
  const headerA = '<<<RESULT:READ:' + rel + ':1-' + half + ' of ' + total + ' [PARTE 1/2] [' + refA + ']>>>';
  const bodyA = linesA.map(function (ln, i) {
    return String(1 + i).padStart(4) + '|' + ln;
  }).join('\n');
  const hintA = '\n\n[Para editar este trecho use <<<OLD_REF:' + refA + ':INICIO-FIM>>> em vez de copiar o OLD.]';

  const headerB = '<<<RESULT:READ:' + rel + ':' + (half + 1) + '-' + total + ' of ' + total + ' [PARTE 2/2] [' + refB + ']>>>';
  const bodyB = linesB.map(function (ln, i) {
    return String(half + 1 + i).padStart(4) + '|' + ln;
  }).join('\n');
  const hintB = '\n\n[Para editar este trecho use <<<OLD_REF:' + refB + ':INICIO-FIM>>> em vez de copiar o OLD.]';

  return {
    ok: true,
    msg:
      headerA + '\n' + bodyA + hintA + '\n<<<END>>>\n\n' +
      headerB + '\n' + bodyB + hintB + '\n<<<END>>>'
  };
}

// ============================================================
// LS
// ============================================================
async function ls(safe, rel) {
  const abs = safe(rel || '.');
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const names = entries
    .filter(function (e) { return !DEFAULT_IGNORE.has(e.name); })
    .map(function (e) { return e.name + (e.isDirectory() ? '/' : ''); })
    .sort();
  return { ok: true, msg: '<<<RESULT:LS:' + (rel || '.') + ' of ' + names.length + '>>>\n' + names.join('\n') + '\n<<<END>>>' };
}

// ============================================================
// WRITE
// ============================================================
async function writeFile(safe, rel, content) {
  const abs = safe(rel);
  try {
    await fs.access(abs);
    return { ok: false, msg: '<<<RESULT:WRITE:' + rel + ':ERROR>>>\nArquivo ja existe. Use EDIT para modificar.\n<<<END>>>' };
  } catch (e) { /* ok, nao existe */ }

  if (typeof content !== 'string' || content.length === 0) {
    return { ok: false, msg: '<<<RESULT:WRITE:' + rel + ':ERROR>>>\nConteudo vazio. WRITE precisa de conteudo entre <<<WRITE:caminho>>> e <<<END>>>.\n<<<END>>>' };
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });

  let formattedContent = content;
  try {
    if (content.length > 20) {
      formattedContent = await formatCode(content, rel);
    }
  } catch (e) {
    formattedContent = content;
  }

  const w = await writeOrValidate(abs, rel, formattedContent, 'WRITE');
  if (!w.ok) return w;

  const addedLines = formattedContent.split('\n').slice(0, DIFF_MAX_LINES);

  return {
    ok: true,
    msg: '<<<RESULT:WRITE:' + rel + ':ok>>>\n' + formattedContent.length + ' bytes escritos (formatado)\n<<<END>>>',
    diff: { removed: [], added: addedLines },
  };
}

// ============================================================
// VALIDACOES HTML
// ============================================================
function cleanBlock(s) {
  return s.replace(/\r\n/g, '\n').replace(/^\s+/, '').replace(/\s+$/, '');
}

function isHtmlFile(rel) {
  return rel.endsWith('.html') || rel.endsWith('.htm');
}

function checkInsideComment(raw, idx, newStr) {
  const before = raw.slice(0, idx);
  const opens = (before.match(/<!--/g) || []).length;
  const closes = (before.match(/-->/g) || []).length;
  const isInsideComment = opens > closes;

  if (!isInsideComment) return { blocked: false };

  const visibleHtml = /<(div|section|header|footer|nav|main|article|aside|form|script|style|iframe|img|video|audio|canvas|svg|button|input|select|textarea|h[1-6]|p|ul|ol|li|table|tr|td|th|span|a)\b/i.test(newStr);
  const functionalAttr = /\b(id|class|data-[\w-]+|href|src)\s*=\s*["'][^"']+["']/i.test(newStr);

  if (visibleHtml || functionalAttr) {
    return {
      blocked: true,
      msg: '<<<RESULT:EDIT:ERROR>>>\nBLOQUEADO: o NEW seria inserido DENTRO de um comentario HTML. Escolha uma ancora FORA de comentario.\n<<<END>>>'
    };
  }
  return { blocked: false };
}

function checkBalancedEdit(raw, start, end, newStr) {
  const oldBlock = raw.slice(start, end);

  const countOpen = (s, tag) => (s.match(new RegExp('<' + tag + '[\\s>]', 'gi')) || []).length;
  const countClose = (s, tag) => (s.match(new RegExp('</' + tag + '>', 'gi')) || []).length;

  const tags = [
    'header', 'nav', 'div', 'section', 'footer', 'main',
    'ul', 'ol', 'li', 'form',
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'span', 'a', 'button',
    'table', 'tr', 'td', 'th',
  ];

  for (const tag of tags) {
    const oldOpen = countOpen(oldBlock, tag);
    const oldClose = countClose(oldBlock, tag);
    const oldBalanced = (oldOpen === oldClose);

    const newOpen = countOpen(newStr, tag);
    const newClose = countClose(newStr, tag);

    if (oldBalanced && oldOpen > 0 && (newOpen !== newClose)) {
      return {
        blocked: true,
        tag: tag,
        oldOpen: oldOpen,
        oldClose: oldClose,
        newOpen: newOpen,
        newClose: newClose
      };
    }
  }
  return { blocked: false };
}

// ============================================================
// findByTokens — match tolerante a espacos/quebras
//
// CORRIGIDO: apos achar o match normalizado, valida que as
// fronteiras (antes do start e depois do end) NAO sao \w no raw.
// Isso evita que "return x" case com "returnx" em outra linha.
// ============================================================
function findByTokens(raw, oldStr) {
  const normalize = (s) => s.replace(/\s+/g, '');
  const rawNorm = normalize(raw);
  const oldNorm = normalize(oldStr);
  if (!oldNorm || rawNorm.length === 0) return null;

  const idx = rawNorm.indexOf(oldNorm);
  if (idx === -1) return null;

  // Mapeia idx (posicao no rawNorm, sem espacos) de volta pro raw
  let rawIdx = 0;
  let normIdx = 0;
  while (normIdx < idx && rawIdx < raw.length) {
    if (!/\s/.test(raw[rawIdx])) normIdx++;
    rawIdx++;
  }
  const start = rawIdx;

  let endNorm = normIdx;
  let endRaw = rawIdx;
  while (endNorm < idx + oldNorm.length && endRaw < raw.length) {
    if (!/\s/.test(raw[endRaw])) endNorm++;
    endRaw++;
  }
  const end = endRaw;

  // Fronteiras: nao casar no meio de identificador
  if (start > 0 && /\w/.test(raw[start - 1]) && /\w/.test(oldStr[0])) return null;
  if (end < raw.length && /\w/.test(raw[end]) && /\w/.test(oldStr[oldStr.length - 1])) return null;

  return { start: start, end: end };
}

// ============================================================
// OLD_REF RESOLUTION
// ============================================================
function resolveOldRef(oldRef, rel, raw) {
  const ref = getRef(oldRef.id);
  if (!ref) {
    return { ok: false, msg: 'referencia ' + oldRef.id + ' nao existe mais (foi expulsa do cache LRU ou o app reiniciou). Releia com READ:' + rel + ' e use o novo ID.' };
  }
  if (ref.path !== rel) {
    return { ok: false, msg: 'referencia ' + oldRef.id + ' e do arquivo ' + ref.path + ', nao ' + rel + '.' };
  }
  if (oldRef.start < ref.start || oldRef.end > ref.end) {
    return { ok: false, msg: 'range ' + oldRef.start + '-' + oldRef.end + ' fora do trecho ' + oldRef.id + ' (' + ref.start + '-' + ref.end + ').' };
  }

  const offsetStart = oldRef.start - ref.start;
  const offsetEnd = oldRef.end - ref.start;
  const originalLines = ref.lines.slice(offsetStart, offsetEnd + 1);

  const currentFileHash = hashOf(raw);
  if (currentFileHash === ref.hash) {
    return { ok: true, lines: originalLines, start: oldRef.start, end: oldRef.end };
  }

  const sliceText = originalLines.join('\n');

  const idx = raw.indexOf(sliceText);
  if (idx !== -1) {
    const second = raw.indexOf(sliceText, idx + 1);
    if (second !== -1) {
      return { ok: false, msg: 'CONTEUDO MUDOU: o trecho ' + oldRef.id + ' (' + oldRef.start + '-' + oldRef.end + ') aparece mais de uma vez no arquivo atual. Use um range maior pra desambiguar, ou releia com READ:' + rel + '.' };
    }
    return { ok: true, lines: sliceText.split('\n'), start: oldRef.start, end: oldRef.end, remapped: true };
  }

  const tokenMatch = findByTokens(raw, sliceText);
  if (tokenMatch) {
    const newLines = raw.slice(tokenMatch.start, tokenMatch.end).split('\n');
    return { ok: true, lines: newLines, start: oldRef.start, end: oldRef.end, remapped: true };
  }

  return {
    ok: false,
    msg: 'CONTEUDO MUDOU DESDE O READ. O arquivo foi modificado (por voce ou por outro editor) depois que voce leu. O trecho ' + oldRef.id + ' (' + oldRef.start + '-' + oldRef.end + ') nao existe mais no arquivo atual.\n\n' +
      'Faca <<<READ:' + rel + '>>> de novo e use o NOVO ID + linhas no OLD_REF.'
  };
}

// ============================================================
// EDIT
// ============================================================
async function editFile(safe, rel, oldStrRaw, newStrRaw, oldRef) {
  const abs = safe(rel);
  const raw = await fs.readFile(abs, 'utf8');
  const html = isHtmlFile(rel);

  let oldStr;
  let oldIndent = '';

  if (oldRef) {
    const resolved = resolveOldRef(oldRef, rel, raw);
    if (!resolved.ok) {
      return { ok: false, msg: '<<<RESULT:EDIT:' + rel + ':ERROR>>>\n' + resolved.msg + '\n<<<END>>>' };
    }
    oldStr = resolved.lines.join('\n');
    const firstNonEmpty = resolved.lines.find(l => l.trim() !== '') || '';
    oldIndent = (firstNonEmpty.match(/^([ \t]*)/) || ['', ''])[1];
  } else {
    oldStr = cleanBlock(oldStrRaw);
  }

  let newStr = cleanBlock(newStrRaw);

  if (!oldStr || oldStr.length === 0) {
    return { ok: false, msg: '<<<RESULT:EDIT:' + rel + ':ERROR>>>\nOLD vazio apos limpeza. Releia com READ.\n<<<END>>>' };
  }

  if (oldRef && newStr.length > 0) {
    let lead = '';
    let trail = '';
    if (oldStr.trim() !== '') {
      lead = (oldStr.match(/^(?:[ \t]*\r?\n)+/) || [''])[0];
      trail = (oldStr.match(/\r?\n[ \t\r\n]*$/) || [''])[0];
    }
    const indent = (oldIndent && !newStr.startsWith(oldIndent)) ? oldIndent : '';
    newStr = lead + indent + newStr + trail;
  }

  function okWithDiff(extraTag) {
    const removedLines = oldStr.split('\n').slice(0, DIFF_MAX_LINES);
    const addedLines = newStr.length > 0
      ? newStr.split('\n').slice(0, DIFF_MAX_LINES)
      : [];
    return {
      ok: true,
      msg: '<<<RESULT:EDIT:' + rel + ':ok' + (extraTag || '') + '>>>\n<<<END>>>',
      diff: { removed: removedLines, added: addedLines },
    };
  }

  let idx = raw.indexOf(oldStr);
  if (idx !== -1) {
    const second = raw.indexOf(oldStr, idx + 1);
    if (second !== -1) {
      return { ok: false, msg: '<<<RESULT:EDIT:' + rel + ':ERROR>>>\nOLD aparece mais de uma vez. Inclua mais contexto.\n<<<END>>>' };
    }
    if (html) {
      const check = checkInsideComment(raw, idx, newStr);
      if (check.blocked) return { ok: false, msg: check.msg };
      const balance = checkBalancedEdit(raw, idx, idx + oldStr.length, newStr);
      if (balance.blocked) {
        return {
          ok: false,
          msg: '<<<RESULT:EDIT:' + rel + ':ERROR>>>\n' +
            'BLOQUEADO: o EDIT deixaria o HTML invalido (<' + balance.tag + '> desbalanceado).\n' +
            'Para REMOVER um bloco inteiro, o OLD deve incluir a ABERTURA e o FECHAMENTO, e o NEW vazio.\n' +
            '<<<END>>>'
        };
      }
    }
    const updated = raw.slice(0, idx) + newStr + raw.slice(idx + oldStr.length);
    const w = await writeOrValidate(abs, rel, updated, 'EDIT');
    if (!w.ok) return w;
    return okWithDiff('');
  }

  const rawLines = raw.split('\n');
  const oldLines = oldStr.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l !== ''; });

  if (oldLines.length === 0) {
    return { ok: false, msg: '<<<RESULT:EDIT:' + rel + ':ERROR>>>\nOLD vazio.\n<<<END>>>' };
  }

  let startLine = -1;
  let endLine = -1;

  for (let i = 0; i < rawLines.length; i++) {
    if (rawLines[i].trim() !== oldLines[0]) continue;
    let oldIdx = 1, rawIdx = i + 1, matched = true;
    while (oldIdx < oldLines.length) {
      while (rawIdx < rawLines.length && rawLines[rawIdx].trim() === '') rawIdx++;
      if (rawIdx >= rawLines.length) { matched = false; break; }
      if (rawLines[rawIdx].trim() !== oldLines[oldIdx]) { matched = false; break; }
      oldIdx++;
      rawIdx++;
    }
    if (matched) { startLine = i; endLine = rawIdx; break; }
  }

  if (startLine !== -1) {
    const actualOld = rawLines.slice(startLine, endLine).join('\n');
    const actualIdx = raw.indexOf(actualOld);
    if (actualIdx === -1) return { ok: false, msg: '<<<RESULT:EDIT:' + rel + ':ERROR>>>\nFalha de mapeamento.\n<<<END>>>' };
    if (html) {
      const check = checkInsideComment(raw, actualIdx, newStr);
      if (check.blocked) return { ok: false, msg: check.msg };
      const balance = checkBalancedEdit(raw, actualIdx, actualIdx + actualOld.length, newStr);
      if (balance.blocked) {
        return {
          ok: false,
          msg: '<<<RESULT:EDIT:' + rel + ':ERROR>>>\n' +
            'BLOQUEADO: o EDIT deixaria o HTML invalido (<' + balance.tag + '> desbalanceado).\n' +
            '<<<END>>>'
        };
      }
    }
    const secondActual = raw.indexOf(actualOld, actualIdx + 1);
    if (secondActual !== -1) return { ok: false, msg: '<<<RESULT:EDIT:' + rel + ':ERROR>>>\nOLD aparece mais de uma vez.\n<<<END>>>' };
    const updated = raw.slice(0, actualIdx) + newStr + raw.slice(actualIdx + actualOld.length);
    const w = await writeOrValidate(abs, rel, updated, 'EDIT');
    if (!w.ok) return w;
    return okWithDiff(' (whitespace de linha ignorado)');
  }

  const tokenMatch = findByTokens(raw, oldStr);
  if (tokenMatch) {
    if (html) {
      const check = checkInsideComment(raw, tokenMatch.start, newStr);
      if (check.blocked) return { ok: false, msg: check.msg };
      const balance = checkBalancedEdit(raw, tokenMatch.start, tokenMatch.end, newStr);
      if (balance.blocked) {
        return {
          ok: false,
          msg: '<<<RESULT:EDIT:' + rel + ':ERROR>>>\nBLOQUEADO: tags <' + balance.tag + '> desbalanceadas.\n<<<END>>>'
        };
      }
    }
    const updated = raw.slice(0, tokenMatch.start) + newStr + raw.slice(tokenMatch.end);
    const w = await writeOrValidate(abs, rel, updated, 'EDIT');
    if (!w.ok) return w;
    return okWithDiff(' (match por tokens normalizados)');
  }

  return { ok: false, msg:
    '<<<RESULT:EDIT:' + rel + ':ERROR>>>\n' +
    'OLD nao encontrado no arquivo.\n' +
    'Tentei 3 modos: (1) match exato, (2) match por linha (ignorando espacos), (3) match por tokens normalizados (ignorando TODOS os espacos/quebras).\n\n' +
    'Possiveis causas:\n' +
    '  - o arquivo foi editado por fora (VS Code, etc) desde o READ\n' +
    '  - voce copiou o OLD com MUITA diferenca de espacos/quebras\n' +
    '  - o trecho aparece mais de uma vez (ambiguo)\n\n' +
    'ACAO: faca <<<READ:' + rel + '>>> de novo e copie EXATAMENTE o texto do READ (incluindo espacos).\n' +
    'DICA: use <<<OLD_REF:Rn:INICIO-FIM>>> em vez de copiar o OLD (mais confiavel).\n' +
    '<<<END>>>'
  };
}

// ============================================================
// RUN
// ============================================================
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const RUN_MAX_OUTPUT = 10 * 1024 * 1024;
const RUN_MAX_RETURNED = 30000;
const SIGKILL_GRACE_MS = 10000;

async function runCmd(root, cmd) {
  const emptyResult = (reason) => ({
    ok: false,
    msg: '<<<RESULT:RUN:ERROR>>>\n' + reason + '\n<<<END>>>',
    exitCode: -1,
    stdout: '',
    stderr: reason,
    killed: false,
    signal: null,
  });

  if (typeof cmd !== 'string' || cmd.trim().length === 0) {
    return emptyResult('comando vazio');
  }

  const trimmed = cmd.trim();
  const isWin = process.platform === 'win32';

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutLen = 0;
    let stderrLen = 0;
    let resolved = false;
    let killedByTimeout = false;
    let killedByUser = false;
    let userKillRequested = false;
    let child;
    let timer;
    let sigkillTimer = null;

    const finish = (exitCode, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
      if (child) activeChildren.delete(child);

      const out = stdout + (stderr ? '\n[stderr]\n' + stderr : '');
      const outTrunc = out.slice(0, RUN_MAX_RETURNED);
      const stdoutOut = stdout.slice(0, RUN_MAX_RETURNED);
      const stderrOut = stderr.slice(0, RUN_MAX_RETURNED);
      const numericExit = (typeof exitCode === 'number') ? exitCode : -1;

      if (killedByUser) {
        resolve({
          ok: false,
          msg: '<<<RESULT:RUN:ERROR>>>\nABORTADO pelo usuario. O processo foi encerrado.\n' +
            outTrunc + '\n<<<END>>>',
          exitCode: numericExit,
          stdout: stdoutOut,
          stderr: stderrOut,
          killed: true,
          signal: signal || null,
        });
        return;
      }

      if (killedByTimeout) {
        resolve({
          ok: false,
          msg: '<<<RESULT:RUN:ERROR>>>\nTIMEOUT: o comando excedeu ' +
            Math.round(RUN_TIMEOUT_MS / 60000) +
            ' minuto(s) e foi encerrado (arvore de processos morta).\n' +
            outTrunc + '\n<<<END>>>',
          exitCode: numericExit,
          stdout: stdoutOut,
          stderr: stderrOut,
          killed: true,
          signal: signal || null,
        });
        return;
      }

      if (numericExit === 0) {
        resolve({
          ok: true,
          msg: '<<<RESULT:RUN:ok>>>\n' + outTrunc + '\n<<<END>>>',
          exitCode: 0,
          stdout: stdoutOut,
          stderr: stderrOut,
          killed: false,
          signal: null,
        });
      } else {
        resolve({
          ok: false,
          msg: '<<<RESULT:RUN:ERROR>>>\n' + outTrunc + '\n<<<END>>>',
          exitCode: numericExit,
          stdout: stdoutOut,
          stderr: stderrOut,
          killed: false,
          signal: signal || null,
        });
      }
    };

    const killByUser = () => {
      if (userKillRequested || resolved) return;
      userKillRequested = true;
      killedByUser = true;
      killProcessTree(child, isWin);
    };

    try {
      child = spawn(trimmed, {
        cwd: root,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve(emptyResult('falha ao iniciar processo: ' + e.message));
    }

    child.__killByUser = killByUser;
    activeChildren.add(child);

    timer = setTimeout(() => {
      killedByTimeout = true;
      killProcessTree(child, isWin);

      sigkillTimer = setTimeout(() => {
        sigkillTimer = null;
        if (!resolved) finish(null, 'SIGKILL');
      }, SIGKILL_GRACE_MS);
    }, RUN_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      if (stdoutLen < RUN_MAX_OUTPUT) {
        stdout += chunk.toString('utf8');
        stdoutLen = stdout.length;
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderrLen < RUN_MAX_OUTPUT) {
        stderr += chunk.toString('utf8');
        stderrLen = stderr.length;
      }
    });

    child.on('error', () => {
      if (resolved) return;
      finish(null, null);
    });

    child.on('close', (code, signal) => {
      finish(code, signal);
    });
  });
}

// ============================================================
// PADROES DESTRUTIVOS
// ============================================================
const DESTRUCTIVE_PATTERNS = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)/i, label: 'remocao forcada (rm -rf/-f)' },
  { re: /\bdel\s+(\/[a-z]+\s+)/i, label: 'remocao forcada (del /f)' },
  { re: /\brmdir\s+(\/[a-z]+\s+)/i, label: 'remocao de diretorio (rmdir /s)' },
  { re: /\bformat\s+[a-z]:/i, label: 'formatacao de disco' },
  { re: /\bmkfs\b/i, label: 'formatacao de filesystem' },
  { re: /\bdd\s+if=/i, label: 'escrita direta em disco (dd)' },
  { re: />\s*\/(dev|proc|sys|etc|bin|sbin|lib|boot|root|home)\b/i, label: 'escrita em diretorio de sistema' },
  { re: /\b(shutdown|reboot|halt|poweroff|restart-computer)\b/i, label: 'desligamento/reinicio do sistema' },
  { re: /\bgit\s+clean\s+-[a-z]*[fdx]/i, label: 'git clean (apaga arquivos nao commitados)' },
  { re: /\bgit\s+reset\s+--hard\b/i, label: 'git reset --hard (descarta mudancas)' },
  { re: /\bgit\s+push\s+.*--force/i, label: 'git push --force (reescreve historico remoto)' },
  { re: /:\(\)\s*\{.*\};\s*:/, label: 'fork bomb' },
  { re: /\bnpm\s+publish\b/i, label: 'publicacao de pacote' },
  { re: /\bnpm\s+unpublish\b/i, label: 'despublicacao de pacote' },
  {
    re: /\b(curl|wget|iwr|invoke-webrequest)\b[\s\S]*?(\|\s*(sh|bash|zsh|powershell|cmd|node|python|python3)\b)/i,
    label: 'download seguido de execucao remota (curl/wget | sh)',
  },
  {
    re: /\b(iex|invoke-expression)\b/i,
    label: 'execucao dinamica PowerShell (Invoke-Expression/iex)',
  },
  {
    re: /\biwr\b[\s\S]*?\|\s*iex/i,
    label: 'download seguido de execucao remota (iwr | iex)',
  },
  {
    re: /\$env:|\b(Get|Set|Remove|New|Copy|Move|Test|Start|Stop)-[A-Z]\w+|\b(Select|Where|ForEach|Sort|Group|Measure|Write|Out|Invoke)-[A-Z]\w+|\b2>\$null\b|\bWrite-Host\b/i,
    label: 'sintaxe PowerShell (o shell e cmd.exe)',
  },
];

function looksLikeTruncation(trimmed) {
  const m = trimmed.match(/^\s*["']([^"']+)["']\s+\S/);
  if (!m) return false;
  const possibleExe = m[1].trim();

  if (/\.(exe|bat|cmd|ps1|com)$/i.test(possibleExe)) return false;
  if (/^[.\/\\]/.test(possibleExe)) return false;
  if (/^[a-z]:[\/\\]/i.test(possibleExe)) return false;
  if (/^[a-z]:\\/i.test(possibleExe)) return false;
  if (/^%[A-Z0-9_]+%/i.test(possibleExe)) return false;
  if (/^\\\\/.test(possibleExe)) return false;

  if (/[*?]/.test(possibleExe)) return true;
  return false;
}

function checkDestructive(cmd) {
  if (typeof cmd !== 'string') return null;
  const trimmed = cmd.trim();

  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.re.test(trimmed)) return p.label;
  }
  if (looksLikeTruncation(trimmed)) {
    return 'possivel truncamento (comeca com aspas, sem executavel)';
  }
  return null;
}

// ============================================================
// EXECUTE (dispatcher)
// ============================================================
async function execute(cmd, projectRoot) {
  const safe = makeSafe(projectRoot);
  switch (cmd.type) {
    case 'read': return readFile(safe, cmd.arg);
    case 'ls': return ls(safe, cmd.arg);
    case 'glob': return glob(safe, projectRoot, cmd.arg);
    case 'grep': return grep(safe, projectRoot, cmd.arg);
    case 'write': return writeFile(safe, cmd.path, cmd.content);
    case 'edit': return editFile(safe, cmd.path, cmd.oldStr, cmd.newStr, cmd.oldRef);
    case 'run': return runCmd(projectRoot, cmd.cmd);
    default: return { ok: false, msg: 'comando desconhecido: ' + cmd.type };
  }
}

module.exports = {
  execute,
  resetReadCache,
  getRef,
  checkDestructive,
  killActiveProcesses,
  getFileContent,
};