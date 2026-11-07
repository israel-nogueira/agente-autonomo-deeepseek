// bridge.js
//
// Camada de I/O com o DeepSeek Web.
//   - ask() devolve { text, html }:
//       * text → pro parser (comandos <<<...>>>, sem markdown)
//       * html → pro renderer (chat bonito, sem comandos)
//   - injectText via setter.call (sem clipboard: DeepSeek transformava em anexo)
//   - click/Enter/abort via CDP
//   - attachFile usa <input type="file"> do DeepSeek
//   - SSE mantido mas desligado (USE_SSE=false)

const SEL = {
  input: 'textarea[placeholder*="Mensagem para DeepSeek" i], textarea[placeholder*="Mensagem" i], textarea[placeholder*="DeepSeek" i], textarea[placeholder*="message" i], textarea, div[contenteditable="true"]',
  assistantMsg: '[data-message-role="assistant"], .ds-markdown, .markdown, .prose, .message-content, div[data-testid*="message"], div[class*="markdown"]',
  stopBtn: 'button[aria-label*="stop" i], button[aria-label*="parar" i], button[aria-label*="interromper" i], button[data-testid*="stop" i], button[data-testid*="cancel" i]',
  newChatBtn: 'a[href="/"], button[aria-label*="novo chat" i], button[aria-label*="new chat" i], button[title*="novo chat" i], button[title*="new chat" i], div[role="button"][aria-label*="novo chat" i], div[role="button"][aria-label*="new chat" i]',
  fileInput: 'input[type="file"]',
};

const USE_SSE = false;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ============================================================
// Helpers novos: decodificar entidades + limpar wrappers
// do DeepSeek + remover comandos <<<...>>> de um HTML.
// ============================================================

// Decodifica &lt; &gt; &amp; &quot; &#39; &nbsp; — importante
// porque o DeepSeek quebra <<< em spans (&lt;&lt;&lt;).
function decodeEntities(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Remove wrappers que o DeepSeek injeta, preservando o conteudo:
//   <span class="ds-markdown-html">...</span>   -> preserva
//   <span class="">...</span>                    -> preserva
//   <span class="">&lt;&lt;</span>              -> vira &lt;&lt; (texto)
// O objetivo e' tirar os spans "vazios" e deixar o texto/HTML original.
function stripDeepSeekWrappers(html) {
  if (typeof html !== 'string') return '';
  return html;
}


// Remove TUDO que for comando <<<...>>> do HTML, incluindo blocos
// multi-linha (WRITE/RUN/EDIT...<<<END>>>). O resultado e' o "chat
// limpo" que o usuario ve.
function stripCommands(html) {
  if (typeof html !== 'string') return '';
  let s = html;

  // 1) Blocos WRITE/RUN/EDIT/SAY ... <<<END>>>  (incluindo os marcadores)
  //    Nota: o corpo pode ter HTML, entao a gente remove ate o END.
  s = s.replace(/<<<\s*(WRITE|RUN|EDIT|SAY)\b[^>]*>>>[\s\S]*?<<<\s*END\s*>>>/gi, '');

  // 2) OLD_REF/OLD/NEW soltos (lixo de EDIT malformado)
  s = s.replace(/<<<\s*(OLD_REF|OLD|NEW)\b[^>]*>>>/gi, '');

  // 3) Comandos simples (READ/LS/TREE/GLOB/GREP/DONE/END)
  s = s.replace(/<<<\s*(READ|LS|TREE|GLOB|GREP|DONE|END)\b[^>]*>>>/gi, '');

  // 4) Linhas que sobraram em branco (3+ \n viram 2)
  s = s.replace(/\n{3,}/g, '\n\n');

  return s;
}

// Aplica decode + stripWrappers + stripCommands. Usado pra
// preparar o HTML do chat antes de mandar pro renderer.
function prepareHtmlForChat(html) {
  let s = stripDeepSeekWrappers(String(html || ''));
  // NAO decodificar entidades: o DeepSeek escapa HTML inline em
  // &lt;kbd&gt; etc., e decodificar transforma em tag de verdade,
  // que o sanitizeHtml remove junto com o conteudo.
  s = stripCommands(s);
  return s.trim();
}

// ============================================================
// SSE (mantido; USE_SSE=false)
// ============================================================
let sseCapture = null;
const SSE_INITIALIZED = new WeakSet();
const SSE_NO_EVENTS_MS = 30 * 1000;
const SSE_TOTAL_MS = 90 * 1000;
const SSE_MAX_CONTINUES = 6;
const SSE_MAX_FAILURES = 3;
let sseFailureCount = 0;
let sseDisabled = false;

const MAX_CONTINUE_CLICKS = 30;

let currentAbortRequested = false;

function resetAbortFlag() { currentAbortRequested = false; }
function resetSseState() { sseDisabled = false; sseFailureCount = 0; }

function abortSse(reason) {
  if (!sseCapture) return false;
  const c = sseCapture;
  const text = extractResponseText(c.state);
  c.finish({ text, html: '', finished: false, autoContinue: false, reason: reason || 'aborted' });
  return true;
}

function requestAbort(chatView) {
  currentAbortRequested = true;
  if (chatView) {
    try {
      const p = abortStreaming(chatView);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* ignora */ }
  }
  abortSse('user_abort');
}

async function ensureDebugger(chatView) {
  const wc = chatView.webContents;
  if (sseDisabled) return false;
  if (SSE_INITIALIZED.has(wc)) return wc.debugger.isAttached();
  try { wc.debugger.attach('1.3'); } catch (e) {
    if (!e.message.includes('already attached')) { sseDisabled = true; return false; }
  }
  try { await wc.debugger.sendCommand('Network.enable'); } catch (e) {
    try { wc.debugger.detach(); } catch (_) {}
    sseDisabled = true;
    return false;
  }
  wc.debugger.on('message', (event, method, params) => {
    if (method === 'Network.eventSourceMessageReceived') handleSseEvent(params);
  });
  SSE_INITIALIZED.add(wc);
  return true;
}

function handleSseEvent(params) {
  if (!sseCapture) return;
  if (sseCapture.markEvent) sseCapture.markEvent();
  if (params.eventName === 'close') { finishCapture('close_event'); return; }
  let data;
  try { data = JSON.parse(params.data); } catch (e) { return; }
  if (data.v && typeof data.v === 'object' && data.v.response) {
    if (sseCapture.requestId && sseCapture.requestId !== params.requestId) return;
    sseCapture.requestId = params.requestId;
    sseCapture.state.response = data.v.response;
    sseCapture.state.response.fragments = sseCapture.state.response.fragments || [];
    checkFinished();
    return;
  }
  if (!sseCapture.state.response) {
    if (data.p) {
      sseCapture.state.response = { fragments: [] };
      try { applyPath(sseCapture.state, data.p, data.o || 'SET', data.v); } catch (e) {}
      checkFinished();
    }
    return;
  }
  if (data.p === undefined && typeof data.v === 'string') {
    const frags = sseCapture.state.response.fragments;
    if (frags.length > 0) {
      const last = frags[frags.length - 1];
      last.content = (last.content || '') + data.v;
    }
    return;
  }
  if (data.p) {
    try { applyPath(sseCapture.state, data.p, data.o || 'SET', data.v); } catch (e) {}
    checkFinished();
  }
}

function applyPath(state, path, op, value) {
  let parts = path.split('/');
  if (parts[0] === 'response') parts = parts.slice(1);
  if (parts.length === 0) {
    if (op === 'BATCH' && Array.isArray(value)) {
      for (const item of value) if (item.p) applyPath(state, 'response/' + item.p, item.o || 'SET', item.v);
    }
    return;
  }
  let cur = state.response;
  for (let i = 0; i < parts.length - 1; i++) {
    let key = parts[i];
    if (key === '-1') key = Array.isArray(cur) ? cur.length - 1 : Object.keys(cur).length - 1;
    if (cur[key] === undefined || cur[key] === null) cur[key] = {};
    cur = cur[key];
  }
  let lastKey = parts[parts.length - 1];
  if (lastKey === '-1') lastKey = Array.isArray(cur) ? cur.length - 1 : Object.keys(cur).length - 1;
  if (op === 'APPEND') {
    if (typeof value === 'string') cur[lastKey] = (cur[lastKey] || '') + value;
    else if (Array.isArray(value)) {
      if (!Array.isArray(cur[lastKey])) cur[lastKey] = [];
      for (const item of value) cur[lastKey].push(item);
    }
  } else if (op === 'SET') cur[lastKey] = value;
  else if (op === 'BATCH' && Array.isArray(value)) {
    for (const item of value) if (item.p) applyPath(state, 'response/' + item.p, item.o || 'SET', item.v);
  }
}

function checkFinished() {
  if (!sseCapture || !sseCapture.state.response) return;
  const r = sseCapture.state.response;
  if (r.status === 'FINISHED' || r.quasi_status === 'FINISHED') finishCapture('finished');
}

function finishCapture(reason) {
  if (!sseCapture) return;
  const c = sseCapture;
  const text = extractResponseText(c.state);
  const autoContinue = !!(c.state.response && c.state.response.auto_continue);
  c.finish({ text, html: text, finished: true, autoContinue, reason });
}

function extractResponseText(state) {
  if (!state || !state.response || !Array.isArray(state.response.fragments)) return '';
  return state.response.fragments.filter(f => f && f.type === 'RESPONSE').map(f => f.content || '').join('');
}

function armCapture() {
  if (sseCapture) {
    try { sseCapture.finish({ text: '', html: '', finished: false, autoContinue: false, reason: 'superseded' }); } catch (e) {}
  }
  return new Promise((resolve) => {
    const captureId = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    let gotEvent = false;
    let resolved = false;
    const finish = (data) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(noEventTimer);
      clearTimeout(totalTimer);
      if (sseCapture && sseCapture.id === captureId) sseCapture = null;
      resolve(data);
    };
    const noEventTimer = setTimeout(() => {
      if (gotEvent) return;
      const text = extractResponseText(sseCapture && sseCapture.id === captureId ? sseCapture.state : { response: null });
      sseFailureCount++;
      if (sseFailureCount >= SSE_MAX_FAILURES) sseDisabled = true;
      finish({ text, html: text, finished: false, autoContinue: false, reason: 'no_events' });
    }, SSE_NO_EVENTS_MS);
    const totalTimer = setTimeout(() => {
      const text = extractResponseText(sseCapture && sseCapture.id === captureId ? sseCapture.state : { response: null });
      sseFailureCount++;
      if (sseFailureCount >= SSE_MAX_FAILURES) sseDisabled = true;
      finish({ text, html: text, finished: false, autoContinue: false, reason: 'timeout' });
    }, SSE_TOTAL_MS);
    sseCapture = { id: captureId, state: { response: null }, requestId: null, finish: finish, markEvent: () => { gotEvent = true; } };
  });
}

async function askViaSse(chatView, prompt, onPromptSent) {
  let allText = '';
  let attempts = 0;
  while (attempts < SSE_MAX_CONTINUES) {
    if (currentAbortRequested) throw new Error('ABORTED_BY_USER');
    attempts++;
    const isContinuation = attempts > 1;
    const capturePromise = armCapture();
    try {
      if (isContinuation) {
        const clicked = await clickContinue(chatView);
        if (!clicked) { abortSse('no_continue_button'); await capturePromise; break; }
      } else {
        await sendPrompt(chatView, prompt);
        if (onPromptSent) onPromptSent();
      }
    } catch (e) {
      abortSse('send_error');
      try { await capturePromise; } catch (_) {}
      throw e;
    }
    const result = await capturePromise;
    allText += result.text;
    if (currentAbortRequested || result.reason === 'user_abort') throw new Error('ABORTED_BY_USER');
    if (!result.finished) {
      if (result.text && result.text.length > 0) return { text: allText, html: allText };
      throw new Error('SSE: ' + (result.reason || 'sem texto'));
    }
    if (!result.autoContinue) return { text: allText, html: allText };
    await sleep(400);
  }
  return { text: allText, html: allText };
}

// ============================================================
// CDP
// ============================================================
async function cdpAttach(chatView) {
  if (!chatView || !chatView.webContents || chatView.webContents.isDestroyed()) return false;
  const wc = chatView.webContents;
  if (wc.debugger.isAttached()) return true;
  try {
    wc.debugger.attach('1.3');
    return true;
  } catch (e) {
    if (e.message && e.message.includes('already attached')) return true;
    console.warn('[bridge] cdpAttach falhou:', e.message);
    return false;
  }
}

async function cdpClickAt(chatView, x, y) {
  if (!chatView || !chatView.webContents || chatView.webContents.isDestroyed()) return false;
  const wc = chatView.webContents;
  if (!(await cdpAttach(chatView))) return false;
  const cx = Math.round(x);
  const cy = Math.round(y);
  try {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none' });
    await sleep(30);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await sleep(50);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
    return true;
  } catch (e) {
    console.warn('[bridge] cdpClickAt falhou:', e.message);
    return false;
  }
}

async function cdpPressEnter(chatView) {
  if (!chatView || !chatView.webContents || chatView.webContents.isDestroyed()) return false;
  const wc = chatView.webContents;
  if (!(await cdpAttach(chatView))) return false;
  try {
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(30);
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    return true;
  } catch (e) {
    console.warn('[bridge] cdpPressEnter falhou:', e.message);
    return false;
  }
}

// ============================================================
// CONTINUAR
// ============================================================
const CONTINUE_SELECTORS = [
  'div[role="button"].ds-button--outlinedNeutral',
  '.ds-button--outlinedNeutral',
  '.ds-button--outlined',
  'button[aria-label*="continuar" i]',
  'button[aria-label*="continue" i]',
];

const CONTINUE_LABELS = ['continuar', 'continue', 'continuar gerando', 'gerar mais', 'continuar resposta'];

async function isContinueVisible(chatView) {
  try {
    return await chatView.webContents.executeJavaScript(`
      (function() {
        var sels = ${JSON.stringify(CONTINUE_SELECTORS)};
        var labels = ${JSON.stringify(CONTINUE_LABELS)};
        for (var i = 0; i < sels.length; i++) {
          var els = document.querySelectorAll(sels[i]);
          for (var j = 0; j < els.length; j++) {
            var el = els[j];
            if (el.offsetParent === null) continue;
            var r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            var text = ((el.innerText || el.textContent || '') + '').trim().toLowerCase();
            for (var k = 0; k < labels.length; k++) {
              if (text.indexOf(labels[k]) !== -1) return true;
            }
          }
        }
        return false;
      })()
    `);
  } catch (e) { return false; }
}

async function findContinueButton(chatView) {
  try {
    return await chatView.webContents.executeJavaScript(`
      (function() {
        var sels = ${JSON.stringify(CONTINUE_SELECTORS)};
        var labels = ${JSON.stringify(CONTINUE_LABELS)};
        for (var i = 0; i < sels.length; i++) {
          var els = document.querySelectorAll(sels[i]);
          for (var j = 0; j < els.length; j++) {
            var el = els[j];
            if (el.offsetParent === null) continue;
            var r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            var text = ((el.innerText || el.textContent || '') + '').trim().toLowerCase();
            for (var k = 0; k < labels.length; k++) {
              if (text.indexOf(labels[k]) !== -1) {
                return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, ariaDisabled: el.getAttribute('aria-disabled'), disabled: el.disabled === true };
              }
            }
          }
        }
        return { found: false };
      })()
    `);
  } catch (e) { return { found: false }; }
}

async function clickContinueIfPresent(chatView) {
  try {
    const info = await findContinueButton(chatView);
    if (!info || !info.found) return 'NOT_FOUND';
    if (info.ariaDisabled === 'true' || info.disabled) return 'DISABLED';

    const cdpOk = await cdpClickAt(chatView, info.x, info.y);
    if (cdpOk) {
      await sleep(500);
      if (!(await isContinueVisible(chatView))) return 'CLICKED';
    }

    const wasVisible = chatView.isVisible();
    if (!wasVisible) {
      try { chatView.show(); chatView.focus(); } catch (e) {}
      await sleep(100);
    }
    try { chatView.webContents.focus(); } catch (e) {}
    await sleep(50);

    try {
      chatView.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(info.x), y: Math.round(info.y) });
      await sleep(50);
      chatView.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(info.x), y: Math.round(info.y), button: 'left', clickCount: 1 });
      await sleep(50);
      chatView.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(info.x), y: Math.round(info.y), button: 'left', clickCount: 1 });
    } catch (e) { /* ignora */ }

    await sleep(800);
    if (!(await isContinueVisible(chatView))) {
      if (!wasVisible && chatView && !chatView.isDestroyed()) {
        try { chatView.hide(); } catch (e) {}
      }
      return 'CLICKED';
    }

    if (!wasVisible && chatView && !chatView.isDestroyed()) {
      try { chatView.hide(); } catch (e) {}
    }

    try {
      await chatView.webContents.executeJavaScript(`
        (function() {
          var sels = ${JSON.stringify(CONTINUE_SELECTORS)};
          var labels = ${JSON.stringify(CONTINUE_LABELS)};
          for (var i = 0; i < sels.length; i++) {
            var els = document.querySelectorAll(sels[i]);
            for (var j = 0; j < els.length; j++) {
              var el = els[j];
              if (el.offsetParent === null) continue;
              var r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) continue;
              var text = ((el.innerText || el.textContent || '') + '').trim().toLowerCase();
              for (var k = 0; k < labels.length; k++) {
                if (text.indexOf(labels[k]) !== -1) { try { el.click(); } catch (e) {} return true; }
              }
            }
          }
          return false;
        })()
      `);
    } catch (e) { /* ignora */ }
    await sleep(300);
    if (!(await isContinueVisible(chatView))) return 'CLICKED';
    return 'NO_EFFECT';
  } catch (e) {
    return 'ERR:' + e.message;
  }
}

async function clickContinue(chatView) {
  const r = await clickContinueIfPresent(chatView);
  return r === 'CLICKED' || r === 'CLICKED_STILL_VISIBLE';
}

// ============================================================
// waitChatReady
// ============================================================
async function waitChatReady(chatView, timeoutMs) {
  timeoutMs = timeoutMs || 30000;
  if (!chatView || !chatView.webContents || chatView.webContents.isDestroyed()) {
    throw new Error('janela do chat nao existe');
  }
  const t0 = Date.now();
  let lastError = null;
  while (Date.now() - t0 < timeoutMs) {
    if (currentAbortRequested) throw new Error('ABORTED_BY_USER');
    try {
      const found = await chatView.webContents.executeJavaScript(
        "!!document.querySelector(" + JSON.stringify(SEL.input) + ")"
      );
      if (found) return true;
    } catch (e) { lastError = e; }
    await sleep(500);
  }
  throw new Error('chat nao carregou em ' + timeoutMs + 'ms. ' + (lastError ? 'Ultimo erro: ' + lastError.message : 'input nao encontrado.'));
}

// ============================================================
// clearInput
// ============================================================
async function clearInput(chatView) {
  try {
    await chatView.webContents.executeJavaScript(`
      (function() {
        var box = document.querySelector(${JSON.stringify(SEL.input)});
        if (!box) return 'NO_INPUT';
        var isTextarea = box.tagName === 'TEXTAREA';
        if (isTextarea) {
          var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(box, '');
          box.dispatchEvent(new Event('input', { bubbles: true }));
          box.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          box.innerText = '';
          box.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
        }
        return 'OK';
      })()
    `);
  } catch (e) { /* ignora */ }
}

// ============================================================
// attachFile
// ============================================================
async function attachFile(chatView, fileName, fileContent) {
  if (!chatView || !chatView.webContents || chatView.webContents.isDestroyed()) {
    return { ok: false, error: 'janela do chat nao existe', fallback: true };
  }

  const safeName = String(fileName || 'arquivo.txt').replace(/[^\w.\-]/g, '_');
  const content = String(fileContent || '');
  const size = Buffer.byteLength(content, 'utf8');

  try {
    const result = await chatView.webContents.executeJavaScript(`
      (function() {
        try {
          var input = document.querySelector(${JSON.stringify(SEL.fileInput)});
          if (!input) return { ok: false, error: 'input[type=file] nao encontrado', fallback: true };
          var content = ${JSON.stringify(content)};
          var fileName = ${JSON.stringify(safeName)};
          var blob = new Blob([content], { type: 'text/plain' });
          var file = new File([blob], fileName, { type: 'text/plain' });
          var dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, attached: true, size: file.size, name: fileName };
        } catch (e) {
          return { ok: false, error: 'excecao: ' + e.message };
        }
      })()
    `, true);

    if (!result || !result.ok) {
      return { ok: false, error: (result && result.error) || 'falha desconhecida', fallback: !!(result && result.fallback) };
    }
    await sleep(400);
    return { ok: true, attached: true, size, name: safeName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================================
// injectText
// ============================================================
async function injectText(chatView, text) {
  const wc = chatView.webContents;
  await clearInput(chatView);
  await sleep(100);

  try {
    await wc.executeJavaScript(`
      (function() {
        var box = document.querySelector(${JSON.stringify(SEL.input)});
        if (!box) return 'NO_INPUT';
        box.focus();
        box.click();
        return 'OK';
      })()
    `);
  } catch (e) { /* ignora */ }
  await sleep(80);

  const payload = JSON.stringify(text);
  const result = await wc.executeJavaScript(
    "(function() {" +
      "var box = document.querySelector(" + JSON.stringify(SEL.input) + ");" +
      "if (!box) return 'NO_INPUT';" +
      "try {" +
        "box.focus(); box.click();" +
        "var isTextarea = box.tagName === 'TEXTAREA';" +
        "if (isTextarea) {" +
          "var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;" +
          "setter.call(box, " + payload + ");" +
          "box.dispatchEvent(new Event('input', { bubbles: true }));" +
          "box.dispatchEvent(new Event('change', { bubbles: true }));" +
        "} else {" +
          "box.innerHTML = '';" +
          "var ok = false;" +
          "try { ok = document.execCommand('insertText', false, " + payload + "); } catch (e) { ok = false; }" +
          "if (!ok) { box.innerText = " + payload + "; }" +
          "box.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));" +
        "}" +
        "var len = (box.value !== undefined ? box.value : box.innerText || '').length;" +
        "return 'OK:' + len;" +
      "} catch (err) { return 'ERR:' + err.message; }" +
    "})()"
  );
  if (result === 'NO_INPUT') throw new Error('input sumiu');
  if (typeof result === 'string' && result.indexOf('ERR:') === 0) throw new Error('injecao: ' + result.slice(4));
  const finalLen = parseInt(result.slice(3), 10);
  if (finalLen < 10) throw new Error('texto nao entrou (len=' + finalLen + ')');
  return finalLen;
}

async function clickSendButton(chatView) {
  const info = await chatView.webContents.executeJavaScript(
    "(function() {" +
      "var textarea = document.querySelector(" + JSON.stringify(SEL.input) + ");" +
      "if (!textarea) return { found: false };" +
      "var taRect = textarea.getBoundingClientRect();" +
      "var buttons = Array.from(document.querySelectorAll('[role=\"button\"], button')).filter(function(b) { return b.offsetParent !== null; });" +
      "var candidates = [];" +
      "for (var i = 0; i < buttons.length; i++) {" +
        "var b = buttons[i];" +
        "var cls = (b.className || '').toString();" +
        "var isPrimary = cls.indexOf('ds-button--primary') !== -1 || b.type === 'submit';" +
        "if (!isPrimary) continue;" +
        "var r = b.getBoundingClientRect();" +
        "candidates.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, dist: Math.abs(r.y - taRect.y) + Math.abs(r.x - taRect.right) });" +
      "}" +
      "if (candidates.length === 0) return { found: false };" +
      "candidates.sort(function(a, b) { return a.dist - b.dist; });" +
      "var best = candidates[0];" +
      "return { found: true, x: best.x, y: best.y };" +
    "})()"
  );
  if (!info || !info.found) return false;

  const cdpOk = await cdpClickAt(chatView, info.x, info.y);
  if (cdpOk) return true;

  const wasVisible = chatView.isVisible();
  if (!wasVisible) {
    try { chatView.show(); chatView.focus(); } catch (e) {}
    await sleep(100);
  }
  try { chatView.webContents.focus(); } catch (e) {}
  try {
    chatView.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(info.x), y: Math.round(info.y) });
    await sleep(50);
    chatView.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(info.x), y: Math.round(info.y), button: 'left', clickCount: 1 });
    await sleep(50);
    chatView.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(info.x), y: Math.round(info.y), button: 'left', clickCount: 1 });
  } catch (e) { /* ignora */ }

  if (!wasVisible && chatView && !chatView.isDestroyed()) {
    await sleep(500);
    try { chatView.hide(); } catch (e) {}
  }
  return true;
}

async function isStopVisible(chatView) {
  try {
    return await chatView.webContents.executeJavaScript(
      "(function() {" +
        "var el = document.querySelector(" + JSON.stringify(SEL.stopBtn) + ");" +
        "if (!el) return false;" +
        "if (el.offsetParent === null) return false;" +
        "var r = el.getBoundingClientRect();" +
        "return r.width > 0 && r.height > 0;" +
      "})()"
    );
  } catch (e) { return false; }
}

async function getInputLength(chatView) {
  try {
    return await chatView.webContents.executeJavaScript(
      "(function() {" +
        "var box = document.querySelector(" + JSON.stringify(SEL.input) + ");" +
        "if (!box) return -1;" +
        "return (box.value !== undefined ? box.value : box.innerText || '').length;" +
      "})()"
    );
  } catch (e) { return -1; }
}

async function countAssistantMessages(chatView) {
  try {
    const n = await chatView.webContents.executeJavaScript(
      "document.querySelectorAll(" + JSON.stringify(SEL.assistantMsg) + ").length"
    );
    return typeof n === 'number' ? n : 0;
  } catch (e) { return 0; }
}

// ============================================================
// sendPrompt
// ============================================================
async function sendPrompt(chatView, prompt) {
  await waitChatReady(chatView);
  await sleep(randomBetween(300, 800));
  await injectText(chatView, prompt);
  await sleep(randomBetween(800, 1500));

  const cdpOk = await cdpPressEnter(chatView);
  if (cdpOk) {
    await sleep(1500);
    const afterLen = await getInputLength(chatView);
    const stopVisible = await isStopVisible(chatView);
    if (stopVisible || afterLen === 0) return;
  }

  const wasVisible = chatView.isVisible();
  if (!wasVisible) {
    try { chatView.show(); chatView.focus(); } catch (e) {}
    await sleep(100);
  }
  try { chatView.webContents.focus(); } catch (e) {}

  const wc = chatView.webContents;
  await sleep(150);
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  await sleep(50);
  wc.sendInputEvent({ type: 'char', keyCode: '\r' });
  await sleep(50);
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });

  await sleep(1500);
  let afterLen = await getInputLength(chatView);
  let stopVisible = await isStopVisible(chatView);

  if (!stopVisible && afterLen > 10) {
    await clickSendButton(chatView);
    await sleep(1500);
    afterLen = await getInputLength(chatView);
    stopVisible = await isStopVisible(chatView);
  }

  if (!stopVisible && afterLen > 10) {
    try { await clearInput(chatView); } catch (e) {}
  }

  if (!wasVisible && chatView && !chatView.isDestroyed()) {
    try { chatView.hide(); } catch (e) {}
  }

  if (!stopVisible && afterLen > 10) {
    throw new Error('falha ao enviar prompt: textarea ainda tem ' + afterLen + ' chars.');
  }
}

// ============================================================
// waitForReply — devolve { text, html }
// ============================================================
async function waitForReply(chatView, timeoutMs, beforeCount) {
  timeoutMs = timeoutMs || 240000;
  const t0 = Date.now();

  let sawAssistant = false;
  let sawStop = false;

  while (Date.now() - t0 < timeoutMs) {
    if (currentAbortRequested) throw new Error('ABORTED_BY_USER');
    try {
      const hasAssistant = await chatView.webContents.executeJavaScript(
        "document.querySelectorAll(" + JSON.stringify(SEL.assistantMsg) + ").length > 0"
      );
      if (hasAssistant) { sawAssistant = true; break; }
    } catch (e) { /* ignora */ }
    await sleep(400);
  }
  if (!sawAssistant) throw new Error('nenhuma resposta apareceu em ' + timeoutMs + 'ms');

  const STABLE_POLLS = 3;
  const POLL_MS = 700;
  let lastText = null;
  let lastHtml = '';
  let stableCount = 0;
  let stopSeenMissing = 0;
  let continueClicks = 0;
  const tStreamStart = Date.now();

  while (Date.now() - tStreamStart < timeoutMs) {
    if (currentAbortRequested) throw new Error('ABORTED_BY_USER');

    let continueVisible = false;
    try { continueVisible = await isContinueVisible(chatView); } catch (e) {}

    if (continueVisible) {
      if (continueClicks < MAX_CONTINUE_CLICKS) {
        const result = await clickContinueIfPresent(chatView);
        continueClicks++;
        stableCount = 0;
        lastText = null;
        if (result === 'NO_EFFECT') await sleep(2000);
        else await sleep(500);
        continue;
      }
    }

    let stopVisible = false;
    try { stopVisible = await isStopVisible(chatView); } catch (e) {}
    if (stopVisible) { sawStop = true; stopSeenMissing = 0; } else { stopSeenMissing++; }

    // Captura TEXTO + HTML da última mensagem
    let currentText = '';
    let currentHtml = '';
    try {
      const rawResult = await chatView.webContents.executeJavaScript(
        "(function() {" +
          "var msgs = document.querySelectorAll(" + JSON.stringify(SEL.assistantMsg) + ");" +
          "if (msgs.length === 0) return { text: '', html: '' };" +
          "var m = msgs[msgs.length - 1];" +
          "return { text: m.innerText || '', html: m.innerHTML || '' };" +
        "})()"
      );
      if (rawResult && typeof rawResult === 'object') {
        currentText = typeof rawResult.text === 'string' ? rawResult.text : '';
        currentHtml = typeof rawResult.html === 'string' ? rawResult.html : '';
      }
    } catch (e) { /* ignora */ }

    if (currentText === lastText && currentText.length > 0) stableCount++;
    else { stableCount = 0; lastText = currentText; lastHtml = currentHtml; }

    const stopGone = !stopVisible && (stopSeenMissing >= 2);
    const textStable = stableCount >= STABLE_POLLS;

    if (stopGone && !continueVisible && textStable) {
      return { text: currentText, html: currentHtml };
    }
    if (!sawStop && !continueVisible && textStable && stableCount >= 6) {
      return { text: currentText, html: currentHtml };
    }
    await sleep(POLL_MS);
  }
  throw new Error('timeout esperando fim do streaming (' + timeoutMs + 'ms)');
}

// ============================================================
// getLastReply — devolve { text, html }
// ============================================================
async function getLastReply(chatView, extraCountBefore) {
  await sleep(randomBetween(400, 900));
  try {
    const rawResult = await chatView.webContents.executeJavaScript(
      "(function() {" +
        "var msgs = document.querySelectorAll(" + JSON.stringify(SEL.assistantMsg) + ");" +
        "if (msgs.length === 0) return { text: '', html: '' };" +
        "var before = " + (typeof extraCountBefore === 'number' ? extraCountBefore : 'null') + ";" +
        "var count = msgs.length;" +
        "if (before === null || count <= before + 1) {" +
          "return { text: msgs[count - 1].innerText || '', html: msgs[count - 1].innerHTML || '' };" +
        "}" +
        "var texts = [];" +
        "var htmls = [];" +
        "for (var i = before; i < count; i++) {" +
          "texts.push(msgs[i].innerText || '');" +
          "htmls.push(msgs[i].innerHTML || '');" +
        "}" +
        "return { text: texts.join('\\n'), html: htmls.join('\\n') };" +
      "})()"
    );
    if (!rawResult || typeof rawResult !== 'object') return { text: '', html: '' };
    return {
      text: typeof rawResult.text === 'string' ? rawResult.text : '',
      html: typeof rawResult.html === 'string' ? rawResult.html : '',
    };
  } catch (e) {
    throw new Error('extracao falhou: ' + e.message);
  }
}

// ============================================================
// ASK — devolve { text, html }
// ============================================================
async function ask(chatView, prompt) {
  if (currentAbortRequested) throw new Error('ABORTED_BY_USER');

  resetSseState();

  let beforeCount = 0;
  try { beforeCount = await countAssistantMessages(chatView); } catch (e) {}

  if (USE_SSE) {
    let sseOk = false;
    try { sseOk = await ensureDebugger(chatView); } catch (e) {}
    if (sseOk) {
      let promptSent = false;
      try {
        return await askViaSse(chatView, prompt, () => { promptSent = true; });
      } catch (e) {
        if (e && e.message === 'ABORTED_BY_USER') throw e;
        if (promptSent) {
          if (currentAbortRequested) throw new Error('ABORTED_BY_USER');
          const r = await waitForReply(chatView, 240000, beforeCount);
          // waitForReply ja devolve { text, html }; o getLastReply e' redundante
          // mas mantemos pra consistencia.
          const lr = await getLastReply(chatView, beforeCount);
          return { text: r.text || lr.text, html: r.html || lr.html };
        }
      }
    }
  }

  try {
    await sendPrompt(chatView, prompt);
    const r = await waitForReply(chatView, 240000, beforeCount);
    const lr = await getLastReply(chatView, beforeCount);
    return { text: r.text || lr.text, html: r.html || lr.html };
  } catch (e) {
    if (e && e.message === 'ABORTED_BY_USER') throw e;
    throw new Error('[bridge] ' + e.message);
  }
}

// ============================================================
// ABORT STREAMING
// ============================================================
async function abortStreaming(chatView) {
  try {
    const info = await chatView.webContents.executeJavaScript(
      "(function() {" +
        "var sels = [" + JSON.stringify(SEL.stopBtn) + "];" +
        "for (var i = 0; i < sels.length; i++) {" +
          "var els = document.querySelectorAll(sels[i]);" +
          "for (var j = 0; j < els.length; j++) {" +
            "var el = els[j];" +
            "if (el.offsetParent === null) continue;" +
            "var r = el.getBoundingClientRect();" +
            "if (r.width <= 0 || r.height <= 0) continue;" +
            "return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };" +
          "}" +
        "}" +
        "return { found: false };" +
      "})()"
    );
    if (!info || !info.found) return 'NOT_FOUND';

    const cdpOk = await cdpClickAt(chatView, info.x, info.y);
    if (cdpOk) return 'CLICKED';

    const wasVisible = chatView.isVisible();
    if (!wasVisible) {
      try { chatView.show(); chatView.focus(); } catch (e) {}
      await sleep(100);
    }
    try { chatView.webContents.focus(); } catch (e) {}
    try {
      chatView.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(info.x), y: Math.round(info.y), button: 'left', clickCount: 1 });
      await sleep(50);
      chatView.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(info.x), y: Math.round(info.y), button: 'left', clickCount: 1 });
    } catch (e) {}
    if (!wasVisible && chatView && !chatView.isDestroyed()) {
      await sleep(300);
      try { chatView.hide(); } catch (e) {}
    }
    return 'CLICKED';
  } catch (e) {
    return 'ERR:' + e.message;
  }
}

async function resetChat(chatView) {
  const wc = chatView.webContents;
  let clickedNewChat = false;
  try {
    const result = await wc.executeJavaScript(
      "(function() {" +
        "var sels = [" + JSON.stringify(SEL.newChatBtn) + "];" +
        "for (var i = 0; i < sels.length; i++) {" +
          "var el = document.querySelector(sels[i]);" +
          "if (el && el.offsetParent !== null) {" +
            "try { el.click(); return 'CLICKED:' + sels[i]; } catch (e) {}" +
          "}" +
        "}" +
        "var all = Array.from(document.querySelectorAll('a, button, div[role=\"button\"]'));" +
        "for (var j = 0; j < all.length; j++) {" +
          "var b = all[j];" +
          "if (b.offsetParent === null) continue;" +
          "var t = (b.innerText || b.textContent || '').trim().toLowerCase();" +
          "if (t.indexOf('novo chat') !== -1 || t.indexOf('new chat') !== -1) {" +
            "try { b.click(); return 'CLICKED_TEXT:' + t.slice(0,30); } catch (e) {}" +
          "}" +
        "}" +
        "return 'NOT_FOUND';" +
      "})()"
    );
    clickedNewChat = (result || '').indexOf('CLICKED') === 0;
  } catch (e) { /* ignora */ }

  if (clickedNewChat) {
    await sleep(1500);
    const t1 = Date.now();
    while (Date.now() - t1 < 15000) {
      if (currentAbortRequested) throw new Error('ABORTED_BY_USER');
      try {
        const found = await wc.executeJavaScript("!!document.querySelector(" + JSON.stringify(SEL.input) + ")");
        if (found) { await sleep(800); return true; }
      } catch (e) { /* ainda carregando */ }
      await sleep(400);
    }
  }

  await wc.loadURL('https://chat.deepseek.com/');
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (currentAbortRequested) throw new Error('ABORTED_BY_USER');
    try {
      const found = await wc.executeJavaScript("!!document.querySelector(" + JSON.stringify(SEL.input) + ")");
      if (found) { await sleep(2500); return true; }
    } catch (e) { /* ainda carregando */ }
    await sleep(500);
  }
  throw new Error('timeout ao recarregar chat');
}

const DISABLE_FEATURES_JS = `
(function() {
  function tryClick(el) { if (!el) return false; try { el.click(); return true; } catch (e) { return false; } }
  function getPressedState(el) { return el.getAttribute('aria-pressed') === 'true'; }
  function findAndSetOff(texts) {
    var all = Array.from(document.querySelectorAll('*')).filter(function(el) {
      if (el.offsetParent === null) return false;
      var t = (el.innerText || el.textContent || '').trim();
      for (var k = 0; k < texts.length; k++) { if (t.toLowerCase().indexOf(texts[k].toLowerCase()) !== -1) return true; }
      return false;
    });
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (getPressedState(el)) { if (tryClick(el)) return true; }
      var p = el.parentElement;
      for (var j = 0; j < 5 && p; j++) {
        var cls = (p.className || '').toString();
        var isToggle = p.getAttribute('tabindex') === '0' || cls.indexOf('ds-toggle-button') !== -1;
        if (isToggle && getPressedState(p)) { if (tryClick(p)) return true; }
        if (p.tagName === 'BUTTON' || p.getAttribute('role') === 'button') {
          if (getPressedState(p)) { if (tryClick(p)) return true; }
        }
        p = p.parentElement;
      }
    }
    return false;
  }
  findAndSetOff(['pesquisa inteligente', 'pesquisa web', 'pesquisa', 'search', 'web search', 'busca web']);
  findAndSetOff(['pensamento profundo', 'deepthink', 'pensamento', 'profundo', 'deep think', 'think']);
  var style = document.createElement('style');
  style.textContent = '[class*="search"]:not([class*="search-input"]),[class*="web-search"],[class*="deepthink"],[class*="deep-think"],[class*="pensamento"],[class*="pesquisa-inteligente"],[class*="websearch"] { display: none !important; }';
  (document.head || document.documentElement).appendChild(style);
  return 'OK';
})()
`;

async function disableDeepSeekFeatures(chatView) {
  const wc = chatView.webContents;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      await wc.executeJavaScript(DISABLE_FEATURES_JS).catch(() => {});
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (e) { /* ignora */ }
}

module.exports = {
  ask,
  resetChat,
  abortStreaming,
  abortSse,
  requestAbort,
  resetAbortFlag,
  resetSseState,
  waitChatReady,
  isStopVisible,
  isContinueVisible,
  clickContinueIfPresent,
  countAssistantMessages,
  SEL,
  disableDeepSeekFeatures,
  attachFile,
  // helpers exportados (podem ser uteis pro loop)
  prepareHtmlForChat,
  decodeEntities,
  stripCommands,
};