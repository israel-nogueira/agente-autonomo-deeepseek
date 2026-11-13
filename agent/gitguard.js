// agent/gitguard.js
// Checagens de Git (somente local, sem rede). A unica escrita e criar a branch do projeto.
const { execFile } = require('child_process');
const path = require('path');

const BRANCH_SUFFIX = '_agente_local';
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const DIFF_MAX_BUFFER = 4 * 1024 * 1024;
const DIFF_TEXT_MAX_CHARS = 300000;
const DIFF_MAX_FILES = 300;

function branchNameFor(slug) {
  return String(slug || '').trim() + BRANCH_SUFFIX;
}

function git(root, args, opts) {
  const options = opts || {};
  const execOpts = { timeout: 15000, windowsHide: true };
  if (typeof options.maxBuffer === 'number' && options.maxBuffer > 0) {
    execOpts.maxBuffer = options.maxBuffer;
  }
  return new Promise(function (resolve) {
    execFile('git', ['-C', root].concat(args), execOpts, function (err, stdout, stderr) {
      resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: String(stderr || (err && err.message) || '').trim(),
        missing: !!(err && err.code === 'ENOENT'),
        killed: !!(err && err.killed),
      });
    });
  });
}

// state: 'none' | 'nogitbin' | 'nogit' | 'nobranch' | 'wrongbranch' | 'ok'
async function gitStatus(projectRoot, slug) {
  const expected = branchNameFor(slug);
  if (!projectRoot || !String(slug || '').trim()) {
    return { state: 'none', current: '', expected: expected };
  }
  const inside = await git(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  if (inside.missing) return { state: 'nogitbin', current: '', expected: expected };
  if (!inside.ok || inside.out !== 'true') return { state: 'nogit', current: '', expected: expected };

  const cur = await git(projectRoot, ['symbolic-ref', '--short', 'HEAD']);
  const current = cur.ok ? cur.out : '(HEAD solto)';

  const exists = await git(projectRoot, ['show-ref', '--verify', '--quiet', 'refs/heads/' + expected]);
  if (!exists.ok) return { state: 'nobranch', current: current, expected: expected };
  if (current !== expected) return { state: 'wrongbranch', current: current, expected: expected };
  return { state: 'ok', current: current, expected: expected };
}

async function createBranch(projectRoot, slug) {
  const st = await gitStatus(projectRoot, slug);
  if (st.state !== 'nobranch') {
    return { ok: false, error: 'nao e possivel criar a branch (estado: ' + st.state + ').' };
  }
  const chk = await git(projectRoot, ['check-ref-format', '--branch', st.expected]);
  if (!chk.ok) return { ok: false, error: 'nome de branch invalido: ' + st.expected };
  const r = await git(projectRoot, ['checkout', '-b', st.expected]);
  if (!r.ok) return { ok: false, error: r.err || 'falha ao criar a branch' };
  return { ok: true, branch: st.expected };
}

async function commitFiles(projectRoot, slug, files, taskText) {
  const st = await gitStatus(projectRoot, slug);
  if (st.state !== 'ok') {
    return { ok: false, error: 'commit so e permitido na branch "' + st.expected + '" (estado: ' + st.state + ').' };
  }
  const list = [];
  const raw = Array.isArray(files) ? files : [];
  for (const f of raw) {
    if (typeof f !== 'string' || !f.trim()) continue;
    const rel = path.relative(projectRoot, path.resolve(projectRoot, f.trim()));
    if (!rel || rel.indexOf('..') === 0 || path.isAbsolute(rel)) {
      return { ok: false, error: 'arquivo fora do projeto: ' + f };
    }
    list.push(rel);
  }
  if (!list.length) return { ok: false, error: 'nenhum arquivo para commitar.' };
  const clean = String(taskText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const msg = 'agente: ' + (clean || 'alteracoes');
  const add = await git(projectRoot, ['add', '--'].concat(list));
  if (!add.ok) return { ok: false, error: add.err || 'falha no git add' };
  const c = await git(projectRoot, ['commit', '-m', msg, '--'].concat(list));
  if (!c.ok) return { ok: false, error: c.out || c.err || 'falha no git commit' };
  const h = await git(projectRoot, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, hash: h.ok ? h.out : '' };
}

async function commitAll(projectRoot, slug, title, fallbackText) {
  const st = await gitStatus(projectRoot, slug);
  if (st.state !== 'ok') {
    return { ok: true, skipped: true, reason: 'branch' };
  }

  const statusRes = await git(projectRoot, ['status', '--porcelain', '--untracked-files=all']);
  const rawOut = statusRes.ok ? statusRes.out : '';
  const lines = rawOut ? rawOut.split('\n').filter(function (l) { return l.trim().length > 0; }) : [];
  if (lines.length === 0) {
    return { ok: true, skipped: true, reason: 'nothing' };
  }
  if (lines.length > 500) {
    return {
      ok: false,
      error: 'muitos arquivos alterados (' + lines.length + '). Confira o .gitignore (node_modules, build...). Nada foi commitado.',
    };
  }

  let rawTitle = String(title || '').trim();
  if (!rawTitle) rawTitle = String(fallbackText || '').trim();
  if (!rawTitle) rawTitle = 'alteracoes';
  let clean = rawTitle.replace(/\s+/g, ' ').trim();
  clean = clean.replace(/[<>]/g, '');
  clean = clean.replace(/^["']+|["']+$/g, '').trim();
  if (clean.length > 72) clean = clean.slice(0, 72);
  if (!clean) clean = 'alteracoes';
  const message = 'agente: ' + clean;

  const add = await git(projectRoot, ['add', '-A']);
  if (!add.ok) return { ok: false, error: add.err || 'falha no git add -A' };

  const c = await git(projectRoot, ['commit', '-m', message]);
  if (!c.ok) return { ok: false, error: c.out || c.err || 'falha no git commit' };

  const h = await git(projectRoot, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, hash: h.ok ? h.out : '', message: message };
}

async function resolveDiffRefs(projectRoot, slug, hash, mode) {
  const st = await gitStatus(projectRoot, slug);
  if (st.state !== 'ok') {
    return { ok: false, error: 'diff so e permitido na branch "' + st.expected + '" (estado: ' + st.state + ').' };
  }
  const h = String(hash || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(h)) return { ok: false, error: 'hash invalido.' };

  const full = await git(projectRoot, ['rev-parse', '--verify', '--quiet', h + '^{commit}']);
  if (!full.ok || !full.out) return { ok: false, error: 'commit nao encontrado.' };

  const anc = await git(projectRoot, ['merge-base', '--is-ancestor', full.out, 'HEAD']);
  if (!anc.ok) return { ok: false, error: 'esse commit nao pertence ao historico da branch atual.' };

  const normalized = (mode === 'current') ? 'current' : 'commit';

  if (normalized === 'current') {
    const head = await git(projectRoot, ['rev-parse', 'HEAD']);
    if (!head.ok || !head.out) return { ok: false, error: 'falha ao ler o HEAD.' };
    return { ok: true, base: head.out, target: full.out, mode: normalized };
  }

  const parent = await git(projectRoot, ['rev-parse', '--verify', '--quiet', full.out + '^']);
  if (parent.ok && parent.out) {
    return { ok: true, base: parent.out, target: full.out, mode: normalized };
  }
  return { ok: true, base: EMPTY_TREE_HASH, target: full.out, mode: normalized };
}

function parseNumstatLine(line) {
  if (!line) return null;
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const a = parts[0];
  const d = parts[1];
  const p = parts.slice(2).join('\t');
  const binary = (a === '-' || d === '-');
  return {
    path: p,
    additions: binary ? 0 : (parseInt(a, 10) || 0),
    deletions: binary ? 0 : (parseInt(d, 10) || 0),
    binary: binary,
  };
}

async function commitDiffFiles(projectRoot, slug, hash, mode) {
  const refs = await resolveDiffRefs(projectRoot, slug, hash, mode);
  if (!refs.ok) return refs;

  const args = [
    '-c', 'core.quotepath=false',
    'diff',
    '--numstat',
    '-z',
    '--no-renames',
    '--no-color',
    '--no-ext-diff',
    refs.base,
    refs.target,
    '--',
  ];

  const r = await git(projectRoot, args, { maxBuffer: DIFF_MAX_BUFFER });
  if (!r.ok) {
    const msg = r.killed
      ? 'diff muito grande (estourou o buffer de 4 MB).'
      : (r.err || 'falha ao gerar diff numstat.');
    return { ok: false, error: msg };
  }

  const raw = r.out;
  const tokens = raw.length > 0 ? raw.split('\u0000') : [];
  const files = [];
  for (const tok of tokens) {
    if (!tok) continue;
    const info = parseNumstatLine(tok);
    if (!info) continue;
    let status = 'M';
    if (info.additions === 0 && info.deletions > 0) status = 'D';
    else if (info.deletions === 0 && info.additions > 0) status = 'A';
    else if (info.additions === 0 && info.deletions === 0 && !info.binary) status = 'M';
    files.push({
      path: info.path,
      status: status,
      additions: info.additions,
      deletions: info.deletions,
      binary: info.binary,
    });
  }

  files.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0); });

  const total = files.length;
  let truncated = false;
  let limited = files;
  if (total > DIFF_MAX_FILES) {
    limited = files.slice(0, DIFF_MAX_FILES);
    truncated = true;
  }

  return { ok: true, mode: refs.mode, files: limited, total: total, truncated: truncated };
}

function isBinaryDiffText(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (text.indexOf('GIT binary patch') !== -1) return true;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && i < 40; i++) {
    if (lines[i].indexOf('Binary files ') === 0 && lines[i].indexOf(' differ') !== -1) return true;
  }
  return false;
}

function truncateDiffText(text, maxChars) {
  if (typeof text !== 'string') return { text: '', truncated: false };
  if (text.length <= maxChars) return { text: text, truncated: false };
  const slice = text.slice(0, maxChars);
  const lastNl = slice.lastIndexOf('\n');
  const cut = lastNl > maxChars * 0.5 ? lastNl : maxChars;
  return { text: slice.slice(0, cut), truncated: true };
}

async function commitFileDiff(projectRoot, slug, hash, mode, file) {
  const f = String(file || '');
  if (!f) return { ok: false, error: 'arquivo invalido.' };
  if (path.isAbsolute(f)) return { ok: false, error: 'arquivo invalido (caminho absoluto).' };
  if (f.indexOf('..') !== -1) return { ok: false, error: 'arquivo invalido (contem ..).' };
  if (f.charAt(0) === '-') return { ok: false, error: 'arquivo invalido (comeca com -).' };

  const refs = await resolveDiffRefs(projectRoot, slug, hash, mode);
  if (!refs.ok) return refs;

  const args = [
    '-c', 'core.quotepath=false',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    '-U5',
    refs.base,
    refs.target,
    '--',
    f,
  ];

  const r = await git(projectRoot, args, { maxBuffer: DIFF_MAX_BUFFER });
  if (!r.ok) {
    const msg = r.killed
      ? 'diff muito grande (estourou o buffer de 4 MB).'
      : (r.err || 'falha ao gerar diff.');
    return { ok: false, error: msg };
  }

  const text = r.out || '';
  if (isBinaryDiffText(text)) {
    return { ok: true, diff: '', binary: true, truncated: false };
  }
  const cut = truncateDiffText(text, DIFF_TEXT_MAX_CHARS);
  return { ok: true, diff: cut.text, binary: false, truncated: cut.truncated };
}

function parseStatLine(txt) {
  const f = /(\d+) files? changed/.exec(txt);
  const i = /(\d+) insertions?\(\+\)/.exec(txt);
  const d = /(\d+) deletions?\(-\)/.exec(txt);
  return {
    files: f ? parseInt(f[1], 10) : 0,
    insertions: i ? parseInt(i[1], 10) : 0,
    deletions: d ? parseInt(d[1], 10) : 0,
  };
}

async function listCommits(projectRoot, slug, limit) {
  const st = await gitStatus(projectRoot, slug);
  if (st.state !== 'ok') {
    return { ok: false, error: 'lista de commits so e permitida na branch "' + st.expected + '" (estado: ' + st.state + ').' };
  }
  let n = parseInt(limit, 10);
  if (!Number.isFinite(n) || n < 1) n = 50;
  if (n > 200) n = 200;
  const r = await git(projectRoot, ['log', '-n', String(n), '--shortstat', '--format=%x1e%H%x1f%h%x1f%at%x1f%s']);
  if (!r.ok) return { ok: false, error: r.err || 'falha no git log' };
  const commits = [];
  const chunks = r.out.split('\x1e');
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf('\n');
    const header = nl === -1 ? chunk : chunk.slice(0, nl);
    const rest = nl === -1 ? '' : chunk.slice(nl + 1);
    const p = header.split('\x1f');
    if (p.length < 4) continue;
    const subject = p.slice(3).join('\x1f').trim();
    const stat = parseStatLine(rest);
    const rm = /^restore:\s*([0-9a-f]{7,40})\b/i.exec(subject);
    commits.push({
      hash: p[0],
      short: p[1],
      ts: parseInt(p[2], 10) * 1000,
      subject: subject,
      files: stat.files,
      insertions: stat.insertions,
      deletions: stat.deletions,
      isRestore: !!rm,
      restoreOf: rm ? rm[1] : '',
    });
  }
  const dirtyRes = await git(projectRoot, ['status', '--porcelain', '--untracked-files=no']);
  const dirty = (dirtyRes.ok && dirtyRes.out)
    ? dirtyRes.out.split('\n').filter(function (l) { return l.trim(); }).length
    : 0;
  return { ok: true, branch: st.current, commits: commits, dirty: dirty };
}

async function restoreCommit(projectRoot, slug, hash) {
  const st = await gitStatus(projectRoot, slug);
  if (st.state !== 'ok') {
    return { ok: false, error: 'restore so e permitido na branch "' + st.expected + '" (estado: ' + st.state + ').' };
  }
  const h = String(hash || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(h)) return { ok: false, error: 'hash invalido.' };
  const full = await git(projectRoot, ['rev-parse', '--verify', '--quiet', h + '^{commit}']);
  if (!full.ok || !full.out) return { ok: false, error: 'commit nao encontrado.' };
  const anc = await git(projectRoot, ['merge-base', '--is-ancestor', full.out, 'HEAD']);
  if (!anc.ok) return { ok: false, error: 'esse commit nao pertence ao historico da branch atual.' };
  const treeTarget = await git(projectRoot, ['rev-parse', full.out + '^{tree}']);
  const treeHead = await git(projectRoot, ['rev-parse', 'HEAD^{tree}']);
  if (!treeTarget.ok || !treeHead.ok) return { ok: false, error: 'falha ao ler a arvore dos commits.' };
  if (treeTarget.out === treeHead.out) return { ok: false, error: 'o projeto ja esta identico a esse commit.' };
  const info = await git(projectRoot, ['log', '-1', '--format=%h%x1f%s', full.out]);
  if (!info.ok) return { ok: false, error: info.err || 'falha ao ler o commit.' };
  const parts = info.out.split('\x1f');
  const short = parts[0];
  const subj = parts.slice(1).join('\x1f').replace(/\s+/g, ' ').trim().slice(0, 60);
  const rt = await git(projectRoot, ['read-tree', '--reset', '-u', full.out]);
  if (!rt.ok) return { ok: false, error: rt.err || 'falha no git read-tree' };
  const msg = 'restore: ' + short + (subj ? ' - ' + subj : '');
  const c = await git(projectRoot, ['commit', '-m', msg]);
  if (!c.ok) {
    await git(projectRoot, ['read-tree', '--reset', '-u', 'HEAD']);
    return { ok: false, error: c.out || c.err || 'falha no git commit (alteracoes desfeitas).' };
  }
  const nh = await git(projectRoot, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, hash: nh.ok ? nh.out : '', restoredTo: short };
}

module.exports = { branchNameFor, gitStatus, createBranch, commitFiles, commitAll, listCommits, restoreCommit, commitDiffFiles, commitFileDiff };