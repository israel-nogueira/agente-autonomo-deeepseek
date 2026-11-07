// compact.js
const { ask, resetChat } = require('./bridge');
const { SYSTEM_PROMPT } = require('./protocol');

const MAX_SUMMARY_CHARS = 4000;

const SUMMARY_PROMPT = [
  'Resuma a sessao de trabalho ate agora em ate 15 linhas.',
  'Inclua OBRIGATORIAMENTE:',
  '1. A tarefa original pedida pelo usuario',
  '2. Arquivos que foram lidos e/ou modificados (nome do arquivo + o que mudou)',
  '3. Decisoes importantes tomadas (ex: escolhas de implementacao)',
  '4. O que ainda falta fazer (se houver)',
  '',
  'Responda APENAS com o resumo em texto puro. NAO use comandos <<< >>>. NAO use markdown. Maximo 15 linhas.',
].join('\n');

const RESUME_INSTRUCTION = [
  'CONTEXTO CARREGADO',
  '',
  'Este chat foi iniciado a partir de uma sessao anterior. O resumo dela:',
  '',
  '---',
  '',
  '__SUMMARY__',
  '',
  '---',
  '',
  'Instrucoes:',
  '- O sistema prompt ja foi carregado e aceito.',
  '- Nao ha tarefa nova agora. Aguarde a proxima mensagem do usuario com a tarefa real.',
  '- Responda APENAS com <<<DONE>>> para confirmar que o resumo foi lido e entendido.',
  '- NAO emita <<<READ>>>, <<<GREP>>>, <<<EDIT>>>, <<<WRITE>>>, <<<RUN>>>, <<<SAY>>> nem nenhum outro comando agora.',
].join('\n');

function makeCompactError(msg, resetDone) {
  const e = new Error(msg);
  e.resetDone = !!resetDone;
  return e;
}

function cleanSummary(text) {
  let s = String(text || '');
  s = s.replace(/```[\s\S]*?```/g, '');
  s = s.replace(/^#{1,6}\s*/gm, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*([^\w*]|$)/g, '$1$2$3');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  s = s.replace(/^[\*\+]\s+/gm, '- ');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();
  return s;
}

function truncateAtLine(text, maxChars) {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastNl = slice.lastIndexOf('\n');
  if (lastNl > maxChars * 0.5) {
    return slice.slice(0, lastNl) + '\n[...truncado]';
  }
  return slice + '\n[...truncado]';
}

function isCleanAck(reply) {
  const s = String(reply || '').trim();
  if (s.length === 0) return true;
  const hasDone = /<<<\s*DONE\s*>>>/i.test(s);
  if (!hasDone) return false;
  const hasCommand = /<<<\s*(READ|WRITE|EDIT|RUN|LS|GLOB|GREP|SAY|TREE)\b/i.test(s);
  if (hasCommand) return false;
  if (s.length > 400) return false;
  return true;
}

async function compactSession({ chatView, sessionLog, onLog, shouldAbort }) {
  const log = onLog || function () {};
  const abort = shouldAbort || function () { return false; };

  // FASE 1: pedir resumo
  if (abort()) throw makeCompactError('ABORTADO pelo usuario antes de compactar', false);

  log('compact: pedindo resumo ao modelo');
  let summaryReply;
  try {
    summaryReply = await ask(chatView, SUMMARY_PROMPT);
  } catch (e) {
    if (e && e.message === 'ABORTED_BY_USER') {
      log('compact: abortado durante o resumo');
      throw makeCompactError('ABORTED_BY_USER', false);
    }
    throw makeCompactError('falha ao pedir resumo: ' + e.message, false);
  }

  let summary = cleanSummary(summaryReply);

  if (summary.length === 0) {
    log('compact: resumo vazio, abortando');
    throw makeCompactError('resumo vazio (modelo nao respondeu)', false);
  }

  if (summary.replace(/\[\.\.\.truncado\]/g, '').trim().length === 0) {
    log('compact: resumo inutil, abortando');
    throw makeCompactError('resumo inutil (modelo nao respondeu conteudo)', false);
  }

  summary = truncateAtLine(summary, MAX_SUMMARY_CHARS);

  const lineCount = summary.split('\n').length;
  log('compact: resumo obtido (' + summary.length + ' chars, ' + lineCount + ' linhas)');

  // FASE 2: resetar chat
  if (abort()) throw makeCompactError('ABORTADO pelo usuario antes de resetar o chat', false);

  log('compact: recarregando chat');
  try {
    await resetChat(chatView);
  } catch (e) {
    if (e && e.message === 'ABORTED_BY_USER') {
      log('compact: abortado durante o reset do chat');
      throw makeCompactError('ABORTED_BY_USER', true);
    }
    log('compact: falha ao resetar chat (' + e.message + ')');
    throw makeCompactError('falha ao resetar chat: ' + e.message, true);
  }

  // Daqui pra baixo, o chat JA FOI RESETADO.
  if (abort()) throw makeCompactError('ABORTADO pelo usuario antes de reinjetar o system prompt', true);

  log('compact: reinjetando system prompt no chat novo');
  let sysAck = '';
  try {
    sysAck = await ask(chatView, SYSTEM_PROMPT);
  } catch (e) {
    if (e && e.message === 'ABORTED_BY_USER') {
      log('compact: abortado durante a injecao do system prompt');
      throw makeCompactError('ABORTED_BY_USER', true);
    }
    log('compact: falha ao injetar system prompt (' + e.message + ')');
    throw makeCompactError('falha ao injetar system prompt: ' + e.message, true);
  }

  let sysClean = isCleanAck(sysAck);
  if (!sysClean) {
    log('compact: resposta ao system prompt nao foi limpa. Tentando resetar + reinjetar (1x).');
    if (abort()) throw makeCompactError('ABORTADO pelo usuario durante o retry do system prompt', true);
    try {
      await resetChat(chatView);
      sysAck = await ask(chatView, SYSTEM_PROMPT);
      sysClean = isCleanAck(sysAck);
    } catch (e) {
      if (e && e.message === 'ABORTED_BY_USER') throw makeCompactError('ABORTED_BY_USER', true);
      log('compact: retry do system prompt falhou (' + e.message + '). Aceitando estado atual.');
      sysClean = false;
    }
  }

  if (!sysClean) {
    log('compact: AVISO: system prompt pode ter gerado comando extra. Continuando mesmo assim.');
  }

  // FASE 3b: reinjetar RESUMO
  if (abort()) throw makeCompactError('ABORTADO pelo usuario antes de reinjetar o resumo', true);

  const resumoMsg = RESUME_INSTRUCTION.replace('__SUMMARY__', summary);
  log('compact: reinjetando resumo no chat novo');

  let resumoAck = '';
  try {
    resumoAck = await ask(chatView, resumoMsg);
  } catch (e) {
    if (e && e.message === 'ABORTED_BY_USER') {
      log('compact: abortado durante a injecao do resumo');
      throw makeCompactError('ABORTED_BY_USER', true);
    }
    log('compact: falha ao injetar resumo (' + e.message + ')');
    throw makeCompactError('falha ao injetar resumo: ' + e.message, true);
  }

  let resumoClean = isCleanAck(resumoAck);
  if (!resumoClean) {
    log('compact: resposta ao resumo nao foi limpa. Tentando resetar + reinjetar (1x).');
    if (abort()) throw makeCompactError('ABORTADO pelo usuario durante o retry do resumo', true);
    try {
      await resetChat(chatView);
      await ask(chatView, SYSTEM_PROMPT);
      resumoAck = await ask(chatView, resumoMsg);
      resumoClean = isCleanAck(resumoAck);
    } catch (e) {
      if (e && e.message === 'ABORTED_BY_USER') throw makeCompactError('ABORTED_BY_USER', true);
      log('compact: retry do resumo falhou (' + e.message + '). Aceitando estado atual.');
      resumoClean = false;
    }
  }

  if (!resumoClean) {
    log('compact: AVISO: resumo pode ter gerado comando extra. Continuando mesmo assim.');
  }

  const newSessionLog = [
    { role: 'user', content: SYSTEM_PROMPT, chars: SYSTEM_PROMPT.length },
    { role: 'assistant', content: '(system prompt aceito)', chars: 22 },
    { role: 'user', content: resumoMsg, chars: resumoMsg.length },
    { role: 'assistant', content: '(resumo aceito)', chars: 16 },
  ];

  log('compact: concluido');
  return {
    summary: summary,
    newSessionLog: newSessionLog,
    resetDone: true,
    chatWasReset: true,
  };
}

module.exports = { compactSession };