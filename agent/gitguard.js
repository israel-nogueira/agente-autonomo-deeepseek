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

module.exports = { branchNameFor, gitStatus, createBranch, commitFiles };