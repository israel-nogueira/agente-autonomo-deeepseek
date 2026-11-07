// parser.js
//
// Parser do protocolo textual. Retorna uma LISTA ORDENADA de segmentos:
//
//   { type: 'text', html: '...' }       → texto (markdown, sanitizado no app.js)
//   { type: 'read', arg: 'path' }       → comando READ
//   { type: 'ls', arg: 'path' }         → comando LS
//   { type: 'glob', arg: 'pattern' }    → comando GLOB
//   { type: 'grep', arg: 'target:pat' } → comando GREP
//   { type: 'write', path, content }    → comando WRITE
//   { type: 'edit', path, oldRef, oldStr, newStr } → comando EDIT
//   { type: 'run', cmd: '...' }         → comando RUN
//   { type: 'done' }                    → DONE
//   { type: 'truncated', what, reason } → bloco malformado
//
// HTML: o texto solto E o conteudo dentro de blocos com body (WRITE/EDIT/RUN)
// sao passados como ESTAO. O app.js sanitiza (allowlist de tags/classes).
// O modelo e' instruido no protocol.js a usar markdown normal.
//
// Markdown e' processado no renderer via marked().

function parseResponse(text) {
  const segments = [];
  if (typeof text !== 'string') return segments;

  const MARKER = /<<<([A-Z_]+)(?::([^>]*))?>>>/g;

  let pos = 0;
  let pendingText = '';

  function flushPendingText() {
    const t = pendingText;
    pendingText = '';
    if (t.trim().length === 0) return;
    segments.push({ type: 'text', html: t });
  }

  while (pos < text.length) {
    MARKER.lastIndex = pos;
    const m = MARKER.exec(text);
    if (!m) {
      pendingText += text.slice(pos);
      break;
    }

    const markerStart = m.index;
    const markerEnd = m.index + m[0].length;
    const tag = m[1];
    const arg = (m[2] || '').trim();

    if (markerStart > pos) {
      pendingText += text.slice(pos, markerStart);
    }

    if (tag === 'READ' || tag === 'LS' || tag === 'TREE' || tag === 'GLOB' || tag === 'GREP') {
      flushPendingText();
      segments.push({ type: tag.toLowerCase(), arg: arg });
      pos = markerEnd;
      continue;
    }

    if (tag === 'DONE') {
      flushPendingText();
      segments.push({ type: 'done' });
      pos = markerEnd;
      continue;
    }

    if (tag === 'END') {
      pos = markerEnd;
      continue;
    }

    if (tag === 'OLD_REF' || tag === 'OLD' || tag === 'NEW') {
      flushPendingText();
      const reason = tag === 'OLD_REF' ? 'orphan_old_ref' : (tag === 'OLD' ? 'orphan_old' : 'orphan_new');
      segments.push({ type: 'truncated', what: 'EDIT', missing: 1, reason: reason });
      pos = markerEnd;
      continue;
    }

    if (tag === 'SAY') {
      flushPendingText();
      const r = readBodyUntilEnd(text, markerEnd);
      if (!r.ok) {
        segments.push({ type: 'truncated', what: 'SAY', missing: 1 });
        pos = r.nextPos;
        continue;
      }
      const body = r.body.replace(/^\n/, '').replace(/\n$/, '');
      if (body.trim().length > 0) {
        segments.push({ type: 'text', html: body });
      }
      pos = r.endPos;
      continue;
    }

    if (tag === 'RUN' || tag === 'WRITE' || tag === 'EDIT') {
      flushPendingText();
      const r = readBodyUntilEnd(text, markerEnd);
      if (!r.ok) {
        segments.push({ type: 'truncated', what: tag, missing: 1 });
        pos = r.nextPos;
        continue;
      }

      if (tag === 'RUN') {
        segments.push({ type: 'run', cmd: r.body.trim() });
      } else if (tag === 'WRITE') {
        segments.push({ type: 'write', path: arg, content: r.body.replace(/^\n/, '') });
      } else if (tag === 'EDIT') {
        const parsed = parseEditBody(r.body);
        if (parsed.ok) {
          parsed.cmd.path = arg;
          segments.push(parsed.cmd);
        } else {
          segments.push({ type: 'truncated', what: 'EDIT', missing: 1, reason: parsed.reason || null });
        }
      }

      pos = r.endPos;
      continue;
    }

    pos = markerEnd;
  }

  flushPendingText();
  return segments;
}

function readBodyUntilEnd(text, bodyStart) {
  const endMatch = findNextEnd(text, bodyStart);
  const nextBlock = findNextBlockMarker(text, bodyStart);

  if (!endMatch) {
    return { ok: false, nextPos: nextBlock ? nextBlock.index : text.length };
  }

  if (nextBlock && nextBlock.index < endMatch.index) {
    return { ok: false, nextPos: nextBlock.index };
  }

  return {
    ok: true,
    body: text.slice(bodyStart, endMatch.index),
    endPos: endMatch.index + endMatch.len,
  };
}

const END_RE = /<<<END>>>/g;

function findNextEnd(text, from) {
  END_RE.lastIndex = from;
  const m = END_RE.exec(text);
  return m ? { index: m.index, len: m[0].length } : null;
}

const BLOCK_OPEN_RE = /<<<(?:WRITE|EDIT|READ|LS|TREE|GLOB|GREP|RUN|SAY|DONE)(?::[^>]*)?>>>/g;

function findNextBlockMarker(text, from) {
  BLOCK_OPEN_RE.lastIndex = from;
  const m = BLOCK_OPEN_RE.exec(text);
  return m ? { index: m.index, len: m[0].length } : null;
}

function parseEditBody(body) {
  const refMatch = body.match(/<<<OLD_REF:([^>]+)>>>/);
  if (refMatch) {
    const refSpec = refMatch[1].trim();
    const refParsed = parseOldRefSpec(refSpec);
    if (!refParsed.ok) {
      return { ok: false, reason: 'OLD_REF mal formado: ' + refSpec };
    }
    const afterRef = body.slice(refMatch.index + refMatch[0].length);
    const newMatch = afterRef.match(/<<<NEW>>>([\s\S]*)$/);
    if (!newMatch) {
      return { ok: false, reason: 'OLD_REF sem <<<NEW>>>' };
    }
    return {
      ok: true,
      cmd: {
        type: 'edit',
        path: null,
        oldRef: refParsed.ref,
        oldStr: null,
        newStr: newMatch[1].replace(/^\n|\n$/g, ''),
      },
    };
  }

  const oldMatch = body.match(/<<<OLD>>>([\s\S]*?)<<<NEW>>>([\s\S]*)$/);
  if (oldMatch) {
    return {
      ok: true,
      cmd: {
        type: 'edit',
        path: null,
        oldRef: null,
        oldStr: oldMatch[1].replace(/^\n|\n$/g, ''),
        newStr: oldMatch[2].replace(/^\n|\n$/g, ''),
      },
    };
  }

  return { ok: false, reason: 'corpo do EDIT sem OLD_REF nem OLD/NEW' };
}

function parseOldRefSpec(spec) {
  const m = spec.match(/^([A-Z]\d+):(\d+)-(\d+)$/);
  if (!m) return { ok: false };
  const start = parseInt(m[2], 10);
  const end = parseInt(m[3], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return { ok: false };
  }
  return { ok: true, ref: { id: m[1], start: start, end: end } };
}

function parseReadArg(arg) {
  const trimmed = String(arg || '').trim();
  if (!trimmed) return { path: '' };

  const m = trimmed.match(/^(.+?):(\d+)([-+])(\d*)$/);
  if (!m) {
    const m2 = trimmed.match(/^(.+?):(\d+)$/);
    if (!m2) return { path: trimmed };
    const n = parseInt(m2[2], 10);
    if (!Number.isFinite(n)) return { path: trimmed };
    return { path: m2[1], start: n, end: n };
  }
  const p = m[1];
  const start = parseInt(m[2], 10);
  const sep = m[3];
  const tail = m[4];

  if (sep === '-') {
    if (tail === '') return { path: p, start: start, end: Infinity };
    const end = parseInt(tail, 10);
    if (!Number.isFinite(end) || end < start) return { path: trimmed };
    return { path: p, start: start, end: end };
  }
  if (tail === '') return { path: p, start: start, end: Infinity };
  const plus = parseInt(tail, 10);
  if (!Number.isFinite(plus) || plus <= 0) return { path: trimmed };
  return { path: p, start: start, end: start + plus - 1 };
}

module.exports = { parseResponse, parseReadArg };