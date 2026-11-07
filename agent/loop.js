// loop.js
const fs = require('fs/promises');
const path = require('path');
const { ask, abortStreaming, attachFile, prepareHtmlForChat } = require('./bridge');
const { parseResponse, parseReadArg } = require('./parser');
const { execute, resetReadCache, checkDestructive, getFileContent, classifyPath } = require('./tools');
const { buildTurn0, buildResultMessage } = require('./protocol');

const MAX_TURNS = 30;
const MAX_EXPLORATION_TURNS = 5;
const MAX_DURATION_MS = 30 * 60 * 1000;
const MAX_EDIT_FAILS_PER_FILE = 4;
const MAX_EDIT_FAILS_TOTAL = 8;

const SESSION_LOG_MAX_CHARS = 100000;

// Extrai IDs de OLD_REF dos cabecalhos do msg de READ:
//   <<<RESULT:READ:caminho:1-200 of 200 (complete) [R1]>>>
//   <<<RESULT:READ:caminho:1-1000 of 2000 [PARTE 1/2] [R1]>>>
// Devolve array de { id, inicio, fim } (1 ou 2 entradas).
function extractReadRefs(msg) {
  const out = [];
  if (typeof msg !== 'string' || msg.length === 0) return out;
  const headerRe = /<<<RESULT:READ:[^>]*?\[([A-Z]\d+)\]>>>/g;
  let m;
  while ((m = headerRe.exec(msg)) !== null) {
    const id = m[1];
    const seg = m[0];
    const rangeMatch = seg.match(/^<<<RESULT:READ:[^:]+:(\d+)-(\d+) of \d+/);
    if (rangeMatch) {
      const inicio = parseInt(rangeMatch[1], 10);
      const fim = parseInt(rangeMatch[2], 10);
      if (Number.isFinite(inicio) && Number.isFinite(fim)) {
        out.push({ id: id, inicio: inicio, fim: fim });
        continue;
      }
    }
    out.push({ id: id, inicio: null, fim: null });
  }
  return out;
}

async function tryAttachReadResult(chatView, projectRoot, cmd, result, log) {
  if (!result || !result.ok) return result;

  try {
    const parsed = parseReadArg(cmd.arg);
    // So anexa leitura de arquivo INTEIRO. Range ja traz ID + linhas no msg.
    if (parsed.start !== undefined) return result;

    const rel = parsed.path;
    const { content, fileName } = await getFileContent(projectRoot, rel);
    if (typeof content !== 'string' || content.length === 0) return result;

    // IDs vieram do msg original (1 ou 2 cabecalhos em arquivos >2000 linhas).
    const refs = extractReadRefs(result.msg);
    if (refs.length === 0) {
      // Fallback seguro: sem ID, nao anexa — o modelo usaria OLD_REF sem ref valida.
      return result;
    }

    // Conteudo numerado igual ao formatRead do tools.js: NNNN|linha.
    const lines = content.split('\n');
    const numbered = lines.map(function (ln, i) {
      return String(i + 1).padStart(4) + '|' + ln;
    }).join('\n');

    const att = await attachFile(chatView, fileName, numbered);

    if (att && att.ok) {
      const sizeKb = Math.round(content.length / 1024);
      log('  attachFile: OK (' + fileName + ', ' + sizeKb + 'kb, ' + refs.length + ' ref(s))');

      const refLines = refs.map(function (r) {
        return '  [' + r.id + '] linhas ' + r.inicio + '-' + r.fim;
      }).join('\n');

      return {
        ok: true,
        msg: '<<<RESULT:READ:' + rel + ':ok — arquivo anexado (' + sizeKb + 'kb)>>>\n' +
             '[O conteudo completo de ' + rel + ' esta no ANEXO desta mensagem, numerado no formato NNNN|linha.]\n' +
             '[Para OLD_REF use os IDs abaixo com linhas INICIO-FIM:]\n' +
             refLines + '\n' +
             '<<<END>>>',
        attached: true,
        attachedName: fileName,
        attachedSize: content.length,
        refs: refs,
      };
    }
    return result;
  } catch (e) {
    return result;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function newCommandId() { return 'c' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

function pruneSessionLog(sessionLog) {
  if (!Array.isArray(sessionLog) || sessionLog.length <= 2) return sessionLog;
  let total = sessionLog.reduce((s, m) => s + (m && m.chars ? m.chars : 0), 0);
  if (total <= SESSION_LOG_MAX_CHARS) return sessionLog;

  const head = sessionLog[0];
  let tail = sessionLog.slice(1);
  let removed = 0;
  while (total > SESSION_LOG_MAX_CHARS && tail.length > 0) {
    const drop = Math.min(2, tail.length);
    for (let i = 0; i < drop; i++) {
      const msg = tail[i];
      if (msg && msg.chars) total -= msg.chars;
    }
    tail = tail.slice(drop);
    removed += drop;
  }
  sessionLog.length = 0;
  sessionLog.push(head);
  for (const m of tail) sessionLog.push(m);
  return sessionLog;
}

function detectRunAntipattern(cmd) {
  if (!cmd) return null;
  const c = cmd;
  if (/(^|[\s;&|])(grep|rg|findstr|ag|ack)(\s|$)/i.test(c)) {
    return 'VOCE USOU grep/rg/findstr via RUN. Para BUSCAR TEXTO use:\n  <<<GREP:src/**:function handleLogin>>>\n  <<<GREP:index.html:slider>>>';
  }
  if (/(^|[\s;&|])(find(\s|$)|dir\s+\/s|ls\s+-r|Get-ChildItem[^\n]*-Recurse)/i.test(c)) {
    return 'VOCE USOU find/dir -Recurse via RUN. Para LISTAR ARQUIVOS use:\n  <<<GLOB:**/*.js>>>\n  <<<GLOB:src/**/*.ts>>>';
  }
  if (/^(cat|type|Get-Content)\s+\S+\s*$/i.test(c.trim())) {
    return 'VOCE USOU cat/type via RUN. Para LER ARQUIVO use:\n  <<<READ:caminho>>>\n  <<<READ:index.html:1-200>>>';
  }
  if (/^(ls|dir)\s*\S*\s*$/i.test(c.trim()) && !/\/s/i.test(c)) {
    return 'VOCE USOU ls/dir via RUN. Para LISTAR DIRETORIO use:\n  <<<LS:caminho>>>\n  <<<GLOB:caminho/**/*>>>';
  }
  if (/(Set-Content|Add-Content|Out-File|\[IO\.File\]::Write|>\s*['"]?\S+\.\w+|>>\s*['"]?\S+\.\w+)/i.test(c)) {
    return 'VOCE TENTOU ESCREVER ARQUIVO via RUN. Use <<<WRITE>>> (novo) ou <<<EDIT>>> (modificar).';
  }
  if (/(^|[\s;&|])(sed|awk|perl\s+-i)(\s|$)/i.test(c)) {
    return 'VOCE USOU sed/awk/perl via RUN. Use <<<EDIT>>>.';
  }
  if (/(^|[\s;&|])(Remove-Item|del\s|rm\s)(\s|$)/i.test(c)) {
    return 'VOCE USOU remocao de arquivo via RUN. Se realmente quer apagar, use RUN com cuidado. Para modificar, use <<<EDIT>>>.';
  }
  if (/\$env:/i.test(c) ||
      /\b(Get|Set|Remove|New|Copy|Move|Test|Start|Stop)-[A-Z]\w+|\b(Select|Where|ForEach|Sort|Group|Measure|Write|Out|Invoke)-[A-Z]\w+|\b2>\$null\b|\bWrite-Host\b/.test(c)) {
    return 'VOCE USOU SINTAXE POWERSHELL, mas o shell padrao e cmd.exe.';
  }
  if (/^\s*["'][^"']*[*?][^"']*["']/.test(c)) {
    return 'Sua resposta parece TRUNCADA ou malformada.';
  }
  return null;
}

async function preload(projectRoot) {
  let tree = '';
  try {
    const treeResult = await execute({ type: 'glob', arg: '**/*' }, projectRoot);
    tree = treeResult.msg || '';
  } catch (e) {
    const entries = await fs.readdir(projectRoot, { withFileTypes: true });
    const treeLines = entries
      .filter(function (e) { return !['node_modules', '.git', 'dist', 'build'].includes(e.name); })
      .map(function (e) { return e.isDirectory() ? e.name + '/' : e.name; })
      .sort();
    tree = '<<<RESULT:LS:.:preload>>>\n' + treeLines.join('\n') + '\n<<<END>>>';
  }

  let pkg = '';
  try {
    const raw = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8');
    pkg = '<<<RESULT:READ:package.json:preload>>>\n' + raw + '\n<<<END>>>';
  } catch (e) { /* sem package.json */ }

  return { tree: tree, files: pkg };
}

function buildInitialInstruction() {
  return [
    '',
    'INSTRUCOES INICIAIS (LEIA COM ATENCAO):',
    '1. Veja a ARVORE DE ARQUIVOS acima (GLOB:**/*).',
    '2. Antes de editar, escolha 2-3 arquivos relevantes e emita',
    '   <<<READ:caminho>>> para cada um.',
    '3. Cada READ devolve o arquivo INTEIRO como ANEXO.',
    '4. NAO fragmente READ. Use READ:caminho sem range.',
    '5. Depois de ler, planeje e edite (EDIT/WRITE).',
    '6. Use texto solto para narrar.',
    '7. Emita <<<DONE>>> SOZINHO quando terminar.',
    '',
  ].join('\n');
}

function truncatedCorrection(seg) {
  const what = seg.what || 'EDIT';
  const reason = seg.reason || null;
  const missing = seg.missing || 1;

  if (reason === 'orphan_old_ref') return '<div class="danger"><strong>MARCADOR SOLTO:</strong> OLD_REF fora de EDIT.</div>';
  if (reason === 'orphan_old') return '<div class="danger"><strong>MARCADOR SOLTO:</strong> OLD fora de EDIT.</div>';
  if (reason === 'orphan_new') return '<div class="danger"><strong>MARCADOR SOLTO:</strong> NEW fora de EDIT.</div>';

  if (what === 'RUN') return '<div class="danger">Sua resposta foi TRUNCADA: faltou END no bloco RUN.</div>';
  if (what === 'WRITE') return '<div class="danger">Sua resposta foi TRUNCADA: faltou END no bloco WRITE.</div>';
  if (what === 'SAY') return '<div class="danger">Sua narracao SAY foi truncada.</div>';

  return '<div class="danger">Sua resposta foi TRUNCADA: faltam ' + missing + ' bloco(s) EDIT com END.</div>';
}

// Conta um EDIT truncado nas estruturas de falha (mesmo limite dos EDITs
// com erro). Devolve { aborted: true, summary } se estourou, ou null.
function countTruncatedEdit(truncated, editFailCounts, totalEditFails, turn) {
  totalEditFails.count++;
  if (totalEditFails.count >= MAX_EDIT_FAILS_TOTAL) {
    return {
      aborted: true,
      summary: 'ABORTADO: ' + totalEditFails.count + ' tentativas de EDIT falharam.',
    };
  }
  return null;
}

async function runAgent(opts) {
  const task = opts.task;
  const projectRoot = opts.projectRoot;
  const chatView = opts.chatView;
  const sessionLog = opts.sessionLog;
  const onLog = opts.onLog || function () {};
  const onCommand = opts.onCommand || function () {};
  const onResult = opts.onResult || function () {};
  const onTurn = opts.onTurn || function () {};
  const shouldAbort = opts.shouldAbort || function () { return false; };
  const confirmRunBatch = opts.confirmRunBatch;
  const runAllowlist = opts.runAllowlist;
  const onAlwaysAllow = opts.onAlwaysAllow;
  const log = function (msg) { onLog(msg); };

  log('runAgent iniciado, task=' + (task ? task.slice(0, 80) : '(vazio)'));

  try {
    const stat = await fs.stat(projectRoot);
    if (!stat.isDirectory()) throw new Error('nao e uma pasta');
  } catch (err) {
    throw new Error('Pasta invalida: ' + projectRoot + ' (' + err.message + ')');
  }

  // resetReadCache();
  try { pruneSessionLog(sessionLog); } catch (e) { /* ignora */ }

  const isFirst = sessionLog.length === 0;
  let pre = null;
  if (isFirst) pre = await preload(projectRoot);

  const startedAt = Date.now();

  let turn0;
  if (isFirst) {
    turn0 = buildTurn0({ task: task, tree: pre.tree, files: pre.files }) + '\n\n' + buildInitialInstruction();
  } else {
    turn0 = '---\n\nTAREFA: ' + task + '\n\n(O contexto do projeto ja foi carregado em turnos anteriores. Nao peca LS/preload de novo a menos que a tarefa exija.)\n';
  }

  await sleep(1000);
  sessionLog.push({ role: 'user', content: turn0, chars: turn0.length });
  log('turn0 tamanho=' + turn0.length + ' chars, enviando...');

  const turnLog = [];

  // Acumula arquivos que foram efetivamente gravados nesta execucao.
  const touchedFilesSet = new Set();
  function recordTouched(cmd) {
    if (!cmd) return;
    if (cmd.type !== 'edit' && cmd.type !== 'write') return;
    const rel = (cmd.path || '').trim();
    if (rel) touchedFilesSet.add(rel);
  }

  let reply, replyHtml;
  try {
    const r = await ask(chatView, turn0);
    reply = r.text;
    replyHtml = r.html;
  } catch (e) {
    if (e && e.message === 'ABORTED_BY_USER') {
      log('abortado pelo usuario antes da primeira resposta');
      try { await abortStreaming(chatView); } catch (_) { /* ignora */ }
      return { turns: 0, aborted: true, summary: 'ABORTADO pelo usuario antes da primeira resposta do modelo.', turnLog: turnLog };
    }
    throw e;
  }
  turnLog.push({ role: 'assistant', content: reply, chars: reply.length });
  onTurn(turnLog);

  // Se o HTML nao veio, usa o texto (fallback).
  if (!replyHtml) replyHtml = reply;

  let turn = 1;
  let explorationStreak = 0;

  const editFailCounts = new Map();
  const totalEditFails = { count: 0 };

  async function askAndLog(msg, persistent) {
    turnLog.push({ role: 'user', content: msg, chars: msg.length });
    if (persistent) sessionLog.push({ role: 'user', content: msg, chars: msg.length });
    const r = await ask(chatView, msg);
    const text = r.text;
    turnLog.push({ role: 'assistant', content: text, chars: text.length });
    if (persistent) sessionLog.push({ role: 'assistant', content: text, chars: text.length });
    try { onTurn(turnLog); } catch (e) { /* ignora */ }
    return r; // { text, html }
  }

  let abortError = null;

  try {
    while (turn <= MAX_TURNS) {
      if (shouldAbort()) {
        log('abort solicitado pelo usuario');
        try { await abortStreaming(chatView); } catch (e) { /* ignora */ }
        return { turns: turn, aborted: true, summary: 'ABORTADO pelo usuario no turno ' + turn + '.', turnLog: turnLog };
      }
      if (Date.now() - startedAt > MAX_DURATION_MS) {
        log('deadline global atingido');
        try { await abortStreaming(chatView); } catch (e) { /* ignora */ }
        return { turns: turn, aborted: true, summary: 'ABORTADO: deadline atingido no turno ' + turn + '.', turnLog: turnLog };
      }

      const segments = parseResponse(reply);

      const truncated = segments.find(function (s) { return s.type === 'truncated'; });
      if (truncated) {
        // ITEM 7a: contar como tentativa de correcao quando for EDIT truncado,
        // igual aos outros EDITs com erro. WRITE/RUN/SAY truncados NAO contam
        // (o limite e' de EDIT).
        if (truncated.what === 'EDIT') {
          const exceeded = countTruncatedEdit(truncated, editFailCounts, totalEditFails, turn);
          if (exceeded) {
            return { turns: turn, aborted: true, summary: exceeded.summary, turnLog: turnLog };
          }
        }

        const msg = truncatedCorrection(truncated);
        const r = await askAndLog(msg, false);
        reply = r.text;
        replyHtml = r.html || r.text;
        turn++;
        explorationStreak = 0;
        continue;
      }

      // Renderiza os textSegments (secao de texto solto) no chat do usuario.
      // O parser gera { type: 'text', html: ... }. Mandamos pro renderer
      // via onResult({ type: 'message', html: ... }).
      const cleanHtml = prepareHtmlForChat(replyHtml);
      if (cleanHtml) {
        try {
          onResult({
            id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            type: 'message',
            html: cleanHtml,
            ok: true,
          });
        } catch (e) { /* ignora */ }
      }

      const workCmds = segments.filter(function (s) {
        return s.type !== 'text' && s.type !== 'done' && s.type !== 'truncated';
      });
      const hasDone = segments.some(function (s) { return s.type === 'done'; });

      if (workCmds.length === 0 && !hasDone) {
        const r = await askAndLog('[Lembrete: emita comandos <<< >>> ou <<<DONE>>>.]', false);
        reply = r.text;
        replyHtml = r.html || r.text;
        turn++;
        continue;
      }

      if (hasDone && workCmds.length === 0) {
        let finalSummary = reply || '';
        finalSummary = finalSummary.replace(/<<<DONE>>>/g, '').trim();

        const touchedFiles = Array.from(touchedFilesSet);
        const needsReview = touchedFiles.length > 0;
        const reviewPrompt = needsReview
          ? ('Revise as alteracoes que voce acabou de fazer nos seguintes arquivos:\n' +
             touchedFiles.map(function (f) { return '- ' + f; }).join('\n') +
             '\n\nLeia cada arquivo alterado (<<<READ:caminho>>>) e verifique: ' +
             'se a mudanca atende exatamente a tarefa original, ' +
             'se nao quebrou a sintaxe, se nao introduziu regressao, ' +
             'e se o estilo e a indentacao estao consistentes. ' +
             'Corrija o que estiver errado com <<<EDIT>>>. ' +
             'Se estiver tudo certo, emita <<<DONE>>> SOZINHO.')
          : '';

        return {
          turns: turn,
          summary: finalSummary,
          turnLog: turnLog,
          needsReview: needsReview,
          touchedFiles: touchedFiles,
          reviewPrompt: reviewPrompt,
        };
      }

      if (workCmds.length > 0) {
        const hasWriteOrEdit = workCmds.some(function (c) { return c.type === 'edit' || c.type === 'write'; });
        const allExploration = workCmds.every(function (c) {
          return c.type === 'read' || c.type === 'grep' || c.type === 'glob' || c.type === 'ls';
        });
        if (allExploration && !hasDone) explorationStreak++;
        else if (hasWriteOrEdit || hasDone) explorationStreak = 0;

        const runBlocked = new Map();
        const runAlreadyOk = new Set();
        const runToConfirm = [];

        for (const cmd of workCmds) {
          if (cmd.type !== 'run') continue;
          const correction = detectRunAntipattern(cmd.cmd);
          if (correction) runBlocked.set(cmd, correction);
          else if (runAllowlist && runAllowlist.has((cmd.cmd || '').trim())) runAlreadyOk.add(cmd);
          else runToConfirm.push(cmd);
        }

        // ITEM 11: WRITE/EDIT em paths sensiveis entram no MESMO lote do RUN.
        const sensitiveCmds = [];
        const sensitiveMeta = new Map();
        for (const cmd of workCmds) {
          if (cmd.type !== 'write' && cmd.type !== 'edit') continue;
          const relPath = (cmd.path || '').trim();
          if (!relPath) continue;
          let info;
          try { info = classifyPath(projectRoot, relPath); }
          catch (e) { info = { sensitive: true, reason: 'falha ao classificar o path.', real: relPath }; }
          if (!info || !info.sensitive) continue;
          sensitiveCmds.push(cmd);
          sensitiveMeta.set(cmd, info);
        }

        const batchDecisions = new Map();
        const sensitiveDecisions = new Map();

        const runItems = runToConfirm.map(function (c) {
          return { cmd: (c.cmd || '').trim(), danger: checkDestructive(c.cmd), kind: 'run' };
        });
        const sensItems = sensitiveCmds.map(function (c) {
          const info = sensitiveMeta.get(c);
          const relPath = (c.path || '').trim();
          return {
            cmd: 'GRAVAR: ' + relPath,
            danger: (info && info.reason) ? info.reason : 'path sensivel',
            kind: c.type, // 'write' | 'edit'
            path: relPath,
            sensitive: true,
          };
        });
        const allItems = runItems.concat(sensItems);

        if (allItems.length > 0 && typeof confirmRunBatch === 'function') {
          let response;
          try { response = await confirmRunBatch(allItems); }
          catch (e) { response = { approved: [], always: [] }; }

          const approvedSet = new Set(response.approved || []);
          const alwaysSet = new Set(response.always || []);

          for (let i = 0; i < runToConfirm.length; i++) {
            batchDecisions.set(runToConfirm[i], { approved: approvedSet.has(i), always: alwaysSet.has(i) });
          }
          const offset = runToConfirm.length;
          for (let j = 0; j < sensitiveCmds.length; j++) {
            const idxInBatch = offset + j;
            sensitiveDecisions.set(sensitiveCmds[j], {
              approved: approvedSet.has(idxInBatch),
              // Item 11: "Sempre permitir" NAO vale para sensiveis.
              always: false,
            });
          }
        } else {
          // Falha fechada: sem confirmRunBatch, RUN e sensivel ficam negados.
          for (const cmd of runToConfirm) batchDecisions.set(cmd, { approved: false, always: false });
          for (const cmd of sensitiveCmds) sensitiveDecisions.set(cmd, { approved: false, always: false });
        }

        const results = [];
        let anyRead = false;
        const attachedPaths = new Set();

        for (const cmd of workCmds) {
          if (cmd.type === 'run' && runBlocked.has(cmd)) {
            const msg = '<<<RESULT:RUN:ERROR>>>\n' + runBlocked.get(cmd) + '\n<<<END>>>';
            const cid = newCommandId();
            results.push({ ok: false, msg });
            onCommand({ id: cid, type: 'run', arg: (cmd.cmd || '').slice(0, 80), cmd: cmd, blocked: true });
            onResult({ id: cid, type: 'run', arg: (cmd.cmd || '').slice(0, 80), result: msg, ok: false, blocked: true });
            continue;
          }

          if (cmd.type === 'run' && !runAlreadyOk.has(cmd)) {
            const decision = batchDecisions.get(cmd);
            if (!decision || !decision.approved) {
              const msg = '<<<RESULT:RUN:ERROR>>>\nNEGADO pelo usuario.\n<<<END>>>';
              const cid = newCommandId();
              results.push({ ok: false, msg });
              onCommand({ id: cid, type: 'run', arg: (cmd.cmd || '').slice(0, 80), cmd: cmd, denied: true });
              onResult({ id: cid, type: 'run', arg: (cmd.cmd || '').slice(0, 80), result: msg, ok: false, denied: true });
              continue;
            }
            if (decision.always) {
              const cmdTrimmed = (cmd.cmd || '').trim();
              if (typeof onAlwaysAllow === 'function') onAlwaysAllow(cmdTrimmed);
              else if (runAllowlist) runAllowlist.add(cmdTrimmed);
            }
          }

          // ITEM 11: WRITE/EDIT sensivel exige aprovacao. Negado = mesmo
          // formato de RUN negado (denied: true), nada e' gravado.
          if ((cmd.type === 'write' || cmd.type === 'edit') && sensitiveDecisions.has(cmd)) {
            const decision = sensitiveDecisions.get(cmd);
            if (!decision || !decision.approved) {
              const relPath = (cmd.path || '').trim();
              const errType = (cmd.type === 'write') ? 'WRITE' : 'EDIT';
              const msg = '<<<RESULT:' + errType + ':' + relPath + ':ERROR>>>\nNEGADO pelo usuario.\n<<<END>>>';
              const cid = newCommandId();
              // ITEM 11 (achado 1): marca denied:true para nao contar como
              // falha de EDIT em editFailCounts/totalEditFails.
              results.push({ ok: false, msg: msg, denied: true });
              onCommand({ id: cid, type: cmd.type, arg: relPath, cmd: cmd, denied: true });
              onResult({ id: cid, type: cmd.type, arg: relPath, result: msg, ok: false, denied: true });
              continue;
            }
            // Aprovado: NAO entra em runAllowlist nem dispara onAlwaysAllow.
          }

          if (cmd.type === 'read') anyRead = true;

          const cid = newCommandId();
          onCommand({ id: cid, type: cmd.type, arg: cmd.arg || cmd.path || cmd.cmd || '', cmd: cmd });
          try {
            let r = await execute(cmd, projectRoot);

            if (cmd.type === 'read' && r.ok) {
              const rel = cmd.arg.split(':')[0].trim();
              if (attachedPaths.has(rel)) {
                const dedupeRefs = extractReadRefs(r.msg);
                const dedupeRefLines = dedupeRefs.length > 0
                  ? '\n[Para OLD_REF use: ' + dedupeRefs.map(function (x) { return '[' + x.id + '] linhas ' + x.inicio + '-' + x.fim; }).join('; ') + ']'
                  : '';
                r = {
                  ok: true,
                  msg: '<<<RESULT:READ:' + rel + ':ok — conteudo ja no anexo anterior>>>\n[O arquivo ' + rel + ' esta no anexo desta mensagem.]' + dedupeRefLines + '\n<<<END>>>',
                  attached: true, attachedName: rel, deduped: true,
                };
              } else {
                const attachResult = await tryAttachReadResult(chatView, projectRoot, cmd, r, log);
                if (attachResult.attached) attachedPaths.add(rel);
                r = attachResult;
              }
            }

            // Registra arquivos realmente gravados (edit/write ok).
            if (r && r.ok && (cmd.type === 'edit' || cmd.type === 'write')) {
              recordTouched(cmd);
            }

            const { msg, ...extras } = r;
            results.push(r);

            onResult({ id: cid, type: cmd.type, arg: cmd.arg || cmd.path || cmd.cmd || '', result: msg, ok: r.ok, ...extras });
          } catch (err) {
            const r = { ok: false, msg: '<<<RESULT:' + cmd.type + ':ERROR>>>\n' + err.message + '\n<<<END>>>' };
            results.push(r);
            onResult({ id: cid, type: cmd.type, arg: cmd.arg || cmd.path || cmd.cmd || '', result: r.msg, ok: false });
          }
        }

        try { onTurn(turnLog); } catch (e) { /* ignora */ }

        const hasError = results.some(function (r) { return !r.ok; });

        // ITEM 11 (achado 1): negações de WRITE/EDIT sensivel NAO contam
        // como falha de EDIT para os limites por arquivo/total.
        const failedEdits = results.filter(function (r) {
          if (r && r.denied === true) return false;
          return r.msg && r.msg.indexOf('<<<RESULT:EDIT:') === 0 && r.msg.indexOf(':ERROR>>>') !== -1;
        });
        if (failedEdits.length > 0) {
          for (const fe of failedEdits) {
            if (fe && fe.denied === true) continue;
            const m = fe.msg.match(/<<<RESULT:EDIT:([^:]+):ERROR>>>/);
            if (!m) continue;
            const failedFile = m[1];
            const prev = editFailCounts.get(failedFile) || 0;
            editFailCounts.set(failedFile, prev + 1);
            totalEditFails.count++;
            if (prev + 1 >= MAX_EDIT_FAILS_PER_FILE) {
              return {
                turns: turn, aborted: true,
                summary: 'ABORTADO: ' + (prev + 1) + ' tentativas de EDIT falharam em ' + failedFile + '.',
                turnLog: turnLog,
              };
            }
          }
          if (totalEditFails.count >= MAX_EDIT_FAILS_TOTAL) {
            return { turns: turn, aborted: true, summary: 'ABORTADO: ' + totalEditFails.count + ' tentativas de EDIT falharam.', turnLog: turnLog };
          }
        }

        if (hasDone && hasWriteOrEdit && !hasError) {
          const r = await askAndLog('Voce emitiu <<<DONE>>> junto de um EDIT/WRITE. Se a tarefa NAO esta completa, continue. Se esta completa, emita <<<DONE>>> SOZINHO.', false);
          reply = r.text;
          replyHtml = r.html || r.text;
          turn++;
          explorationStreak = 0;
          continue;
        }

        if (explorationStreak >= MAX_EXPLORATION_TURNS && !hasError && !hasDone) {
          const r = await askAndLog('Voce ja explorou ' + explorationStreak + ' turnos sem editar. Emita <<<EDIT>>> AGORA, ou <<<DONE>>> se a tarefa terminou.', false);
          reply = r.text;
          replyHtml = r.html || r.text;
          turn++;
          explorationStreak = 0;
          continue;
        }

        if (hasError || !hasDone) {
          const resultMsg = buildResultMessage(results);
          await sleep(2000 + Math.random() * 2000);
          log('enviando resultados (len=' + resultMsg.length + ', anyRead=' + anyRead + ')');
          const r = await askAndLog(resultMsg, false);
          reply = r.text;
          replyHtml = r.html || r.text;
          turn++;
          continue;
        }
      }

      if (hasDone) {
        let finalSummary = reply || '';
        finalSummary = finalSummary.replace(/<<<DONE>>>/g, '');
        finalSummary = finalSummary.trim();

        const touchedFiles = Array.from(touchedFilesSet);
        const needsReview = touchedFiles.length > 0;
        const reviewPrompt = needsReview
          ? ('Revise as alteracoes que voce acabou de fazer nos seguintes arquivos:\n' +
             touchedFiles.map(function (f) { return '- ' + f; }).join('\n') +
             '\n\nLeia cada arquivo alterado (<<<READ:caminho>>>) e verifique: ' +
             'se a mudanca atende exatamente a tarefa original, ' +
             'se nao quebrou a sintaxe, se nao introduziu regressao, ' +
             'e se o estilo e a indentacao estao consistentes. ' +
             'Corrija o que estiver errado com <<<EDIT>>>. ' +
             'Se estiver tudo certo, emita <<<DONE>>> SOZINHO.')
          : '';

        return {
          turns: turn,
          summary: finalSummary,
          turnLog: turnLog,
          needsReview: needsReview,
          touchedFiles: touchedFiles,
          reviewPrompt: reviewPrompt,
        };
      }

      turn++;
    }
  } catch (e) {
    if (e && e.message === 'ABORTED_BY_USER') abortError = e;
    else {
      // ITEM 19: preserva turnLog no erro (sem mudar o contrato — re-lanca o
      // MESMO erro, anexando turnLog).
      try { e.turnLog = turnLog; } catch (_) { /* ignora */ }
      throw e;
    }
  }

  if (abortError) {
    try { await abortStreaming(chatView); } catch (e) { /* ignora */ }
    return { turns: turn, aborted: true, summary: 'ABORTADO pelo usuario no turno ' + turn + '.', turnLog: turnLog };
  }

  // ITEM 19: limite de turnos — anexa turnLog ao erro antes de lancar.
  const limitErr = new Error('limite de ' + MAX_TURNS + ' turnos atingido');
  try { limitErr.turnLog = turnLog; } catch (_) { /* ignora */ }
  throw limitErr;
}

module.exports = { runAgent, pruneSessionLog, SESSION_LOG_MAX_CHARS };