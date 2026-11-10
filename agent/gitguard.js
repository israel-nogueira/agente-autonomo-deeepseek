// agent/gitguard.js
// Checagens de Git (somente local, sem rede). A unica escrita e criar a branch do projeto.
const { execFile } = require('child_process');

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

module.exports = { branchNameFor, gitStatus, createBranch };