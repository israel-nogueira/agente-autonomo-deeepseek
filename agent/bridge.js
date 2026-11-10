// bridge.js
//
// Camada de I/O com o DeepSeek Web.
//   - ask() devolve { text, html }:
//       * text → pro parser (comandos <<<...>>>, sem markdown)
//       * html → pro renderer (chat bonito, sem comandos)
//   - injectText via setter.call (sem clipboard: DeepSeek transformava em anexo)
//   - click/Enter/abort via CDP
//   - attachFile usa <input type="file"> do DeepSeek

const SEL = {
  input: 'textarea[placeholder*="Mensagem para DeepSeek" i], textarea[placeholder*="Mensagem" i], textarea[placeholder*="DeepSeek" i], textarea[placeholder*="message" i], textarea, div[contenteditable="true"]',
  assistantMsg: '[data-message-role="assistant"], .ds-markdown, .markdown, .prose, .message-content, div[data-testid*="message"], div[class*="markdown"]',
  stopBtn: 'button[aria-label*="stop" i], button[aria-label*="parar" i], button[aria-label*="interromper" i], button[data-testid*="stop" i], button[data-testid*="cancel" i]',
  newChatBtn: 'a[href="/"], button[aria-label*="novo chat" i], button[aria-label*="new chat" i], button[title*="novo chat" i], button[title*="new chat" i], div[role="button"][aria-label*="novo chat" i], div[role="button"][aria-label*="new chat" i]',
  fileInput: 'input[type="file"]',
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ============================================================
// Helpers: decodificar entidades + limpar wrappers
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

  // 0) Normaliza marcadores escritos com entidades (&lt;&lt;&lt;...&gt;&gt;&gt;)
  //    para o formato literal <<<...>>>, removendo spans. Sem isso, os blocos
  //    de comando do DeepSeek nao casam com as regex abaixo.
  s = s.replace(/<\/?span\b[^>]*>/gi, '');
  s = s.replace(/&lt;&lt;&lt;\s*(WRITE|RUN|EDIT|SAY|OLD_REF|OLD|NEW|READ|LS|TREE|GLOB|GREP|DONE|END)\b([^<]*?)&gt;&gt;&gt;/gi, '<<<$1$2>>>');

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

// Fatia o HTML da resposta nas posicoes dos comandos, na ordem em que
// aparecem. Devolve um array com cmdCount + 1 trechos de HTML ja limpo
// (qualquer posicao pode ser ''): o trecho [i] vem ANTES do comando i e o
// ultimo vem DEPOIS do ultimo comando. Devolve null se a quantidade de
// comandos achados no HTML for diferente de cmdCount (o chamador faz fallback).
function splitHtmlByCommands(html, cmdCount) {
  let s = stripDeepSeekWrappers(String(html || ''));
  s = s.replace(/<\/?span\b[^>]*>/gi, '');
  s = s.replace(/&lt;&lt;&lt;\s*(WRITE|RUN|EDIT|SAY|OLD_REF|OLD|NEW|READ|LS|TREE|GLOB|GREP|DONE|END)\b([^<]*?)&gt;&gt;&gt;/gi, '<<<$1$2>>>');

  const cutRe = /<<<\s*(?:WRITE|RUN|EDIT)\b[^>]*>>>[\s\S]*?<<<\s*END\s*>>>|<<<\s*(?:READ|LS|GLOB|GREP)\b[^>]*>>>/gi;
  const chunks = [];
  let last = 0;
  let m;
  while ((m = cutRe.exec(s)) !== null) {
    chunks.push(s.slice(last, m.index));
    last = m.index + m[0].length;
  }
  chunks.push(s.slice(last));
  if (chunks.length - 1 !== cmdCount) return null;

  return chunks.map(function (c) {
    let h = stripCommands(c).trim();
    h = h.replace(/^(?:\s*<\/[a-z0-9]+>)+/i, '').replace(/(?:<(?:p|div)\b[^>]*>\s*)+$/i, '');
    h = h.replace(/<p\b[^>]*>\s*<\/p>/gi, '').trim();
    const visible = h.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim() !== '' ||
      /<(?:hr|img|pre|table|ul|ol|blockquote|h[1-6])\b/i.test(h);
    return visible ? h : '';
  });
}

// ============================================================
// Abort
// ============================================================
const MAX_CONTINUE_CLICKS = 30;

let currentAbortRequested = false;

function resetAbortFlag() { currentAbortRequested = false; }

function requestAbort(chatView) {
  currentAbortRequested = true;
  if (chatView) {
    try {
      const p = abortStreaming(chatView);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* ignora */ }
  }
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

// Le o estado do botao de enviar (mesma busca de candidatos que
// clickSendButton: primario/type=submit, visivel, mais proximo do canto
// superior direito do textarea). NAO altera clickSendButton.
// Devolve 'ENABLED' | 'DISABLED' | 'NOT_FOUND'.
async function getSendButtonState(chatView) {
  if (!chatView || !chatView.webContents || chatView.webContents.isDestroyed()) {
    return 'NOT_FOUND';
  }
  try {
    const st = await chatView.webContents.executeJavaScript(
      "(function() {" +
        "var textarea = document.querySelector(" + JSON.stringify(SEL.input) + ");" +
        "if (!textarea) return 'NOT_FOUND';" +
        "var taRect = textarea.getBoundingClientRect();" +
        "var buttons = Array.from(document.querySelectorAll('[role=\"button\"], button')).filter(function(b) { return b.offsetParent !== null; });" +
        "var candidates = [];" +
        "for (var i = 0; i < buttons.length; i++) {" +
          "var b = buttons[i];" +
          "var cls = (b.className || '').toString();" +
          "var isPrimary = cls.indexOf('ds-button--primary') !== -1 || b.type === 'submit';" +
          "if (!isPrimary) continue;" +
          "var r = b.getBoundingClientRect();" +
          "if (r.width <= 0 || r.height <= 0) continue;" +
          "candidates.push({ el: b, x: r.x + r.width / 2, y: r.y + r.height / 2, dist: Math.abs(r.y - taRect.y) + Math.abs(r.x - taRect.right) });" +
        "}" +
        "if (candidates.length === 0) return 'NOT_FOUND';" +
        "candidates.sort(function(a, b) { return a.dist - b.dist; });" +
        "var best = candidates[0].el;" +
        "var clsBest = (best.className || '').toString().toLowerCase();" +
        "var pe = '';" +
        "try { pe = (window.getComputedStyle(best).pointerEvents || '') + ''; } catch (e) { pe = ''; }" +
        "var isDisabled = (best.disabled === true) ||" +
                          "(best.getAttribute('aria-disabled') === 'true') ||" +
                          "(clsBest.indexOf('disabled') !== -1) ||" +
                          "(pe.toLowerCase() === 'none');" +
        "return isDisabled ? 'DISABLED' : 'ENABLED';" +
      "})()"
    );
    if (st === 'ENABLED' || st === 'DISABLED' || st === 'NOT_FOUND') return st;
    return 'NOT_FOUND';
  } catch (e) {
    return 'NOT_FOUND';
  }
}

// Espera o botao de enviar ficar habilitado (uploads de anexo podem
// demorar). Sem timeout fixo de UPLOAD — o maxMs e' so um teto de
// seguranca para nao travar o app para sempre.
async function waitSendButtonEnabled(chatView, maxMs) {
  maxMs = maxMs || 15 * 60 * 1000;
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < maxMs) {
    if (currentAbortRequested) throw new Error('ABORTED_BY_USER');
    const st = await getSendButtonState(chatView);
    if (st !== last) { console.log('[bridge] botao enviar: ' + st); last = st; }
    if (st !== 'DISABLED') return st;
    await sleep(1000);
  }
  return 'TIMEOUT';
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
  await waitSendButtonEnabled(chatView);
  await sleep(500);

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

  const SEND_RETRY_MAX_MS = 90000;
  const SEND_RETRY_EVERY_MS = 2500;
  let tRetry = Date.now();
  while (!stopVisible && afterLen > 10 && (Date.now() - tRetry) < SEND_RETRY_MAX_MS) {
    if (currentAbortRequested) throw new Error('ABORTED_BY_USER');
    await sleep(SEND_RETRY_EVERY_MS);
    afterLen = await getInputLength(chatView);
    stopVisible = await isStopVisible(chatView);
    if (stopVisible || afterLen <= 10) break;
    const stBtn = await getSendButtonState(chatView);
    if (stBtn === 'DISABLED') { tRetry = Date.now(); continue; }
    const okEnter = await cdpPressEnter(chatView);
    if (!okEnter) { await clickSendButton(chatView); }
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
async function waitForReply(chatView, timeoutMs, beforeCount, beforeText, onProgress) {
  timeoutMs = timeoutMs || 240000;
  if (typeof beforeText !== 'string') beforeText = '';
  const t0 = Date.now();

  let sawAssistant = false;
  let sawStop = false;

  while (Date.now() - t0 < timeoutMs) {
    if (currentAbortRequested) throw new Error('ABORTED_BY_USER');
    try {
      const probe = await chatView.webContents.executeJavaScript(
        "(function() {" +
          "var msgs = document.querySelectorAll(" + JSON.stringify(SEL.assistantMsg) + ");" +
          "var count = msgs.length;" +
          "var lastText = count > 0 ? (msgs[count - 1].innerText || '') : '';" +
          "return { count: count, lastText: lastText };" +
        "})()"
      );
      const count = (probe && typeof probe.count === 'number') ? probe.count : 0;
      const lastText = (probe && typeof probe.lastText === 'string') ? probe.lastText : '';
      const isNew = (count > (typeof beforeCount === 'number' ? beforeCount : 0)) ||
                    (count > 0 && lastText.length > 0 && lastText !== beforeText);
      if (isNew) { sawAssistant = true; break; }
    } catch (e) { /* ignora */ }
    await sleep(400);
  }
  if (!sawAssistant) throw new Error('nenhuma resposta apareceu em ' + timeoutMs + 'ms');

  const STABLE_POLLS = 3;
  const POLL_MS = 700;
  let lastText = null;
  let lastHtml = '';
  let lastProgressText = null;
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

    if (typeof onProgress === 'function' && currentText.length > 0 && currentText !== lastProgressText) {
      lastProgressText = currentText;
      try { onProgress(currentText); } catch (e) { /* ignora */ }
    }

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
async function ask(chatView, prompt, onProgress) {
  if (currentAbortRequested) throw new Error('ABORTED_BY_USER');

  let beforeCount = 0;
  try { beforeCount = await countAssistantMessages(chatView); } catch (e) {}

  let beforeText = '';
  try {
    beforeText = await chatView.webContents.executeJavaScript(
      "(function() {" +
        "var msgs = document.querySelectorAll(" + JSON.stringify(SEL.assistantMsg) + ");" +
        "if (msgs.length === 0) return '';" +
        "return msgs[msgs.length - 1].innerText || '';" +
      "})()"
    );
    if (typeof beforeText !== 'string') beforeText = '';
  } catch (e) { beforeText = ''; }

  try {
    await sendPrompt(chatView, prompt);
    const r = await waitForReply(chatView, 240000, beforeCount, beforeText, onProgress);
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
    var all = Array.from(document.querySelectorAll('button, [role="button"], [role="switch"], [aria-pressed]')).filter(function(el) {
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
  requestAbort,
  resetAbortFlag,
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
  splitHtmlByCommands,
};