// agent/gitguard.js
// Checagens de Git (somente local, sem rede). A unica escrita e criar a branch do projeto.
const { execFile } = require('child_process');
const path = require('path');

const BRANCH_SUFFIX = '_agente_local';

function branchNameFor(slug) {
  return String(slug || '').trim() + BRANCH_SUFFIX;
}

function git(root, args) {
  return new Promise(function (resolve) {
    execFile('git', ['-C', root].concat(args), { timeout: 15000, windowsHide: true }, function (err, stdout, stderr) {
      resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: String(stderr || (err && err.message) || '').trim(),
        missing: !!(err && err.code === 'ENOENT'),
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

module.exports = { branchNameFor, gitStatus, createBranch, commitFiles, listCommits, restoreCommit };