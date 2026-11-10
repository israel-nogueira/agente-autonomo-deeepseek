'use strict';

const $ = (id) => document.getElementById(id);

const state = {
	activeProjectId: null,
	activeChatUuid: null,
	projects: [],
	chats: [],
	chat: null,
	running: false,
	stats: null,
	chatWindowVisible: true,
	activeAssistantBlock: null,
	booted: false,
	histPage: 0,
	histTotal: 0,
};

const TOKENS_WARN = 12000;
const TOKENS_DANGER = 20000;
const TASKS_WARN = 5;
const TASKS_DANGER = 10;

let creatingProject = false;
let pendingCommands = new Map();
let pendingRunBatch = null;
let pendingDelete = null;
let modalProjectMode = 'create';
let editingProjectId = null;

let overlayTimer = null;
let overlayRetryFn = null;

function fmtNum(n) { return (n || 0).toLocaleString('pt-BR'); }
function timeNow() {
	return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(ts) {
	if (!ts) return '';
	const d = new Date(ts);
	const today = new Date();
	if (d.toDateString() === today.toDateString()) {
		return 'Hoje · ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
	}
	return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' · ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function escapeHtml(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function stripProtocol(msg) {
	if (typeof msg !== 'string') return '';
	let s = msg;
	s = s.replace(/^<<<RESULT:[^>]*>>>\s*/i, '');
	s = s.replace(/\s*<<<END>>>\s*$/i, '');
	s = s.replace(/<<<END>>>/gi, '');
	return s.trim();
}

function showDiag(msg, ok, opts) {
	opts = opts || {};
	const b = $('diag-banner');
	b.style.display = 'flex';
	b.style.alignItems = 'center';
	b.style.gap = '10px';
	b.style.pointerEvents = 'auto';
	b.style.zIndex = '25000';
	b.style.background = ok ? '#14532d' : '#7f1d1d';
	b.style.color = ok ? '#bbf7d0' : '#fecaca';
	b.style.border = '1px solid ' + (ok ? '#15803d' : '#991b1b');
	b.innerHTML = '';

	const txt = document.createElement('span');
	txt.style.flex = '1';
	txt.textContent = msg;
	b.appendChild(txt);

	if (opts.actionLabel && typeof opts.onAction === 'function') {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.textContent = opts.actionLabel;
		btn.style.cssText = 'padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.15);color:#fff;font-size:11px;font-weight:700;cursor:pointer;flex-shrink:0';
		btn.addEventListener('click', () => {
			b.style.display = 'none';
			try { opts.onAction(); } catch (e) {}
		});
		b.appendChild(btn);
	}

	clearTimeout(b._t);
	b._t = setTimeout(() => { b.style.display = 'none'; }, opts.duration || 8000);
}

function clearPendingTimers() {
	for (const [, entry] of pendingCommands) clearTimeout(entry.timer);
	pendingCommands.clear();
}

function showOverlay(title, caption) {
	if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
	$('overlayTitle').textContent = title || 'Aguarde…';
	$('overlayCaption').textContent = caption || '';
	$('overlaySpinner').style.display = '';
	$('overlayActions').style.display = 'none';
	overlayRetryFn = null;
	$('overlay').style.display = 'flex';
}

function showOverlayDelayed(title, caption, delayMs) {
	if ($('overlay').style.display === 'flex') {
		$('overlayTitle').textContent = title || 'Aguarde…';
		$('overlayCaption').textContent = caption || '';
		return;
	}
	if (overlayTimer) clearTimeout(overlayTimer);
	overlayTimer = setTimeout(() => {
		overlayTimer = null;
		showOverlay(title, caption);
	}, delayMs || 300);
}

function hideOverlay() {
	if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
	$('overlay').style.display = 'none';
	overlayRetryFn = null;
}

function overlayError(msg, retryFn) {
	if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
	$('overlay').style.display = 'flex';
	$('overlaySpinner').style.display = 'none';
	$('overlayTitle').textContent = 'Algo deu errado';
	$('overlayCaption').textContent = msg || 'Falha inesperada.';
	$('overlayActions').style.display = 'flex';
	overlayRetryFn = retryFn || null;
}

$('overlayRetry').addEventListener('click', () => {
	const fn = overlayRetryFn;
	hideOverlay();
	if (typeof fn === 'function') {
		try { fn(); } catch (e) { showDiag('Erro: ' + e.message, false); }
	}
});

$('overlayCancel').addEventListener('click', () => { hideOverlay(); });

function hideBootCover() {
	const c = $('bootCover');
	c.classList.add('hidden');
	setTimeout(() => { c.style.display = 'none'; }, 350);
}

async function boot() {
	if (state.booted) return;
	state.booted = true;
	try {
		const st = await window.projectsAPI.state();
		applyState(st);
		try { await restoreHistory(); } catch (e) {}
	} catch (e) { showDiag('Falha ao carregar projetos: ' + e.message, false); }
	try {
		const v = await window.agentAPI.isChatVisible();
		applyChatWindowState(v);
	} catch (e) {}
	try {
		const s = await window.agentAPI.stats();
		applyStats(s);
	} catch (e) {}
}

window.appAPI.onReady((data) => {
	hideBootCover();
	if (data && data.ok) boot();
	else showDiag('Boot reportou erro: ' + (data && data.error ? data.error : 'desconhecido'), false);
});

setTimeout(() => {
	if (!state.booted) { hideBootCover(); boot(); }
}, 30000);

function applyState(st) {
	if (!st) return;
	state.activeProjectId = st.activeProjectId || null;
	state.activeChatUuid = st.activeChatUuid || null;
	state.projects = st.projects || [];
	state.chats = st.chats || [];
	state.chat = st.chat || null;
	state.activeAssistantBlock = null;
	renderProjects();
	renderChats();
	renderHeader();
	updateComposerState(state.running);
}

function renderProjects() {
	const list = $('projectsList');
	list.innerHTML = '';
	if (!state.projects.length) {
		list.innerHTML = '<div class="session-empty">Nenhum projeto. Clique em + para criar.</div>';
		return;
	}
	for (const p of state.projects) {
		const btn = document.createElement('button');
		btn.className = 'project' + (p.id === state.activeProjectId ? ' active' : '');
		btn.type = 'button';
		btn.innerHTML =
			'<svg class="i"><use href="#i-folder"/></svg>' +
			'<span class="project-copy">' +
				'<span class="project-name">' + escapeHtml(p.name) + '</span>' +
				'<span class="project-path">' + escapeHtml(p.projectRoot || '(sem pasta)') + '</span>' +
			'</span>' +
			'<span class="project-menu">' +
				'<button type="button" title="Opções" data-menu="1"><svg class="i"><use href="#i-dots"/></svg></button>' +
			'</span>';
		btn.addEventListener('click', async (ev) => {
			const menuBtn = ev.target.closest('[data-menu]');
			if (menuBtn) { ev.stopPropagation(); openProjectMenu(p, menuBtn); return; }
			await activateProject(p.id);
		});
		list.appendChild(btn);
	}
}

function renderChats() {
	const list = $('sessionsList');
	const q = ($('sessionFilter').value || '').trim().toLowerCase();
	list.innerHTML = '';
	const filtered = state.chats.filter(c => {
		if (!q) return true;
		return (c.label || '').toLowerCase().includes(q) || (c.uuid || '').toLowerCase().includes(q);
	});
	if (!filtered.length) {
		list.innerHTML = '<div class="session-empty">' + (state.chats.length ? 'Nenhuma sessão corresponde à busca.' : 'Nenhuma sessão ainda.<br>Envie a primeira tarefa para criar.') + '</div>';
		return;
	}
	for (const c of filtered) {
		const isPending = (c.uuid || '').indexOf('pending-') === 0;
		const isActive = !!c.isActive;
		const item = document.createElement('button');
		item.className = 'session-item' + (isActive ? ' active' : '');
		item.type = 'button';
		item.title = isActive ? 'Sessão ativa' : 'Clique para carregar esta sessão';
		if (isActive) item.style.cursor = 'default';

		item.innerHTML =
			'<svg class="i"><use href="#i-chats"/></svg>' +
			'<span class="session-copy">' +
				'<span class="session-title">' +
					escapeHtml(c.label || c.uuid) +
					(isActive ? ' <span class="session-pending-badge" style="background:#1b2b45;color:#82acff;border-color:#30476c;">ativa</span>' : '') +
					(isPending && !isActive ? ' <span class="session-pending-badge">pendente</span>' : '') +
				'</span>' +
				'<span class="session-date">' + fmtDate(c.lastUsedAt) + ' · ' + fmtNum(c.sessionChars) + ' chars</span>' +
				'<span class="session-uuid">' + escapeHtml(c.uuid) + '</span>' +
			'</span>' +
			'<span class="session-actions">' +
				'<button type="button" title="Abrir em popup (somente leitura)" data-act="popup"><svg class="i"><use href="#i-external"/></svg></button>' +
				'<button type="button" title="Renomear" data-act="rename"><svg class="i"><use href="#i-edit"/></svg></button>' +
				'<button type="button" title="Excluir" data-act="delete"><svg class="i"><use href="#i-trash"/></svg></button>' +
			'</span>';

		item.addEventListener('click', async (ev) => {
			const act = ev.target.closest('[data-act]');
			if (act) {
				ev.stopPropagation();
				const action = act.getAttribute('data-act');
				if (action === 'popup') return openPopup(c);
				if (action === 'rename') return promptRenameChat(c);
				if (action === 'delete') return promptDeleteChat(c);
				return;
			}
			if (isActive) return;
			const wrap = $('sessionsWrap');
			if (wrap) wrap.open = false;
			await activateChat(c);
		});

		list.appendChild(item);
	}
}

function renderHeader() {
	const p = state.projects.find(x => x.id === state.activeProjectId);
	const c = state.chat;
	$('activeTitle').textContent = p ? p.name : '—';
	if (p && c) {
		$('activeSubtitle').textContent = (p.projectRoot || '(sem pasta)') + ' · ' + (c.label || c.uuid);
	} else if (p) {
		$('activeSubtitle').textContent = (p.projectRoot || '(sem pasta)') + ' · (envie a primeira tarefa para criar uma sessão)';
	} else {
		$('activeSubtitle').textContent = 'Crie um projeto para começar';
	}
}

let popupCloseHandler = null;

function openProjectMenu(project, anchorEl) {
	closeProjectMenu();
	const popup = $('projectPopup');
	popup.innerHTML = '';

	const itemRename = makePopupItem('i-edit', 'Renomear', false);
	itemRename.addEventListener('click', () => { closeProjectMenu(); promptRenameProject(project); });

	const itemRoot = makePopupItem('i-folder', 'Alterar pasta raiz', false);
	itemRoot.addEventListener('click', () => { closeProjectMenu(); promptEditRoot(project); });

	const sep = document.createElement('div');
	sep.className = 'project-popup-sep';

	const itemDelete = makePopupItem('i-trash', 'Remover projeto', true);
	itemDelete.addEventListener('click', () => { closeProjectMenu(); promptDeleteProject(project); });

	popup.appendChild(itemRename);
	popup.appendChild(itemRoot);
	popup.appendChild(sep);
	popup.appendChild(itemDelete);

	popup.style.display = 'flex';
	popup.style.visibility = 'hidden';

	const rect = anchorEl.getBoundingClientRect();
	const popupRect = popup.getBoundingClientRect();
	const viewportH = window.innerHeight;
	const viewportW = window.innerWidth;

	let left = rect.left;
	if (left + popupRect.width > viewportW - 8) left = Math.max(8, viewportW - popupRect.width - 8);
	let top = rect.bottom + 6;
	if (top + popupRect.height > viewportH - 8) top = Math.max(8, rect.top - popupRect.height - 6);

	popup.style.left = left + 'px';
	popup.style.top = top + 'px';
	popup.style.visibility = '';
	popup.classList.add('show');

	setTimeout(() => {
		popupCloseHandler = (ev) => { if (!popup.contains(ev.target)) closeProjectMenu(); };
		document.addEventListener('mousedown', popupCloseHandler);
	}, 0);

	document.addEventListener('keydown', onPopupKeydown);
}

function makePopupItem(iconId, label, danger) {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = 'project-popup-item' + (danger ? ' danger' : '');
	b.innerHTML = '<svg class="i"><use href="#' + iconId + '"/></svg><span>' + escapeHtml(label) + '</span>';
	return b;
}

function closeProjectMenu() {
	const popup = $('projectPopup');
	if (!popup) return;
	popup.classList.remove('show');
	popup.style.display = 'none';
	if (popupCloseHandler) {
		document.removeEventListener('mousedown', popupCloseHandler);
		popupCloseHandler = null;
	}
	document.removeEventListener('keydown', onPopupKeydown);
}

function onPopupKeydown(ev) { if (ev.key === 'Escape') closeProjectMenu(); }
window.addEventListener('resize', () => closeProjectMenu());

async function activateProject(projectId) {
	if (state.running) return alert('Existe uma tarefa em andamento. Aguarde ou clique em Parar.');
	if (projectId === state.activeProjectId) return;
	showOverlay('Trocando de projeto…', 'Carregando o chat ativo do projeto.');
	try {
		const res = await window.projectsAPI.setActive(projectId);
		if (!res.ok) { overlayError(res.error, () => activateProject(projectId)); return; }
		hideOverlay();
		clearTimeline();
		applyState(res.state);
		try { await restoreHistory(); } catch (e) {}
		if (res.stats) applyStats(res.stats);
	} catch (e) { overlayError(e.message, () => activateProject(projectId)); }
}

async function activateChat(chat) {
	if (state.running) return alert('Existe uma tarefa em andamento. Aguarde ou clique em Parar.');
	if (!chat || !chat.uuid) return;
	if (chat.uuid === state.activeChatUuid) return;
	showOverlay('Trocando de sessão…', 'Carregando a sessão selecionada.');
	try {
		const res = await window.projectsAPI.switchChat(state.activeProjectId, chat.uuid);
		if (!res.ok) { overlayError(res.error, () => activateChat(chat)); return; }
		hideOverlay();
		clearTimeline();
		applyState(res.state);
		try { await restoreHistory(); } catch (e) {}
		if (res.stats) applyStats(res.stats);
	} catch (e) { overlayError(e.message, () => activateChat(chat)); }
}

function promptRenameProject(project) {
	$('modalRenameTitle').textContent = 'Renomear projeto';
	$('modalRenameCaption').textContent = 'Novo nome para "' + project.name + '".';
	$('renameInput').value = project.name;
	$('modalRename').style.display = 'flex';
	$('modalRename').dataset.mode = 'project';
	$('modalRename').dataset.id = project.id;
	$('renameRemoteWrap').style.display = 'none';
	setTimeout(() => $('renameInput').focus(), 50);
}

function promptRenameChat(chat) {
	$('modalRenameTitle').textContent = 'Renomear sessão';
	$('modalRenameCaption').textContent = 'Novo nome para "' + (chat.label || chat.uuid) + '".';
	$('renameInput').value = chat.label || '';
	$('modalRename').style.display = 'flex';
	$('modalRename').dataset.mode = 'chat';
	$('modalRename').dataset.id = chat.uuid;
	$('renameRemoteWrap').style.display = 'flex';
	$('renameRemote').checked = false;
	setTimeout(() => { $('renameInput').focus(); $('renameInput').select(); }, 50);
}

function promptDeleteProject(project) {
	pendingDelete = { type: 'project', id: project.id };
	let realCount = 0;
	try {
		if (project.id === state.activeProjectId) {
			realCount = state.chats.filter(c => (c.uuid || '').indexOf('pending-') !== 0).length;
		} else {
			realCount = project.chatCount || 0;
		}
	} catch (e) { realCount = project.chatCount || 0; }

	$('modalDeleteTitle').textContent = 'Remover projeto';
	$('modalDeleteCaption').textContent =
		'Remover "' + project.name + '"? ' +
		(realCount > 0 ? 'O projeto tem ' + realCount + ' sessão(ões) no DeepSeek.' : 'O projeto não tem sessões no DeepSeek (só placeholders).');

	$('modalDeleteBody').style.display = 'flex';
	$('modalDeleteRemote').checked = false;
	const labelSpan = $('modalDeleteBody').querySelector('span');
	if (labelSpan) {
		labelSpan.textContent = realCount > 0
			? 'Também apagar ' + realCount + ' sessão(ões) no DeepSeek (serão perdidas para sempre)'
			: 'Também apagar no DeepSeek (não há sessões reais para apagar)';
	}
	$('modalDelete').style.display = 'flex';
}

function promptDeleteChat(chat) {
	pendingDelete = { type: 'chat', id: chat.uuid };
	const isPending = (chat.uuid || '').indexOf('pending-') === 0;
	const isActive = !!chat.isActive;
	$('modalDeleteTitle').textContent = 'Remover sessão';
	$('modalDeleteCaption').textContent =
		'Remover "' + (chat.label || chat.uuid) + '" do projeto?' +
		(isActive ? ' Esta é a sessão ATIVA — depois de remover, o app vai criar uma nova sessão na próxima tarefa.' : '');
	$('modalDeleteBody').style.display = 'flex';
	$('modalDeleteRemote').checked = false;
	$('modalDeleteRemote').disabled = isPending;
	const labelSpan = $('modalDeleteBody').querySelector('span');
	if (labelSpan) {
		labelSpan.textContent = isPending
			? 'Esta sessão é um placeholder (ainda não foi registrada no DeepSeek)'
			: 'Também apagar no DeepSeek (a conversa será perdida para sempre)';
	}
	$('modalDelete').style.display = 'flex';
}

function promptEditRoot(project) {
	editingProjectId = project.id;
	modalProjectMode = 'editRoot';
	$('modalProjectTitle').textContent = 'Alterar pasta raiz';
	$('projectNameInput').value = project.name;
	$('projectNameInput').disabled = true;
	$('projectSlugInput').value = project.slug || slugify(project.name);
	$('projectSlugInput').disabled = true;
	$('projectRootInput').value = project.projectRoot || '';
	$('modalProject').style.display = 'flex';
}

function slugify(s) {
	return String(s || '')
		.normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // remove acentos
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')                        // nao-alfanumerico vira -
		.replace(/^-+|-+$/g, '')                            // tira - das pontas
		.slice(0, 60);
}


async function openNewProject() {
	modalProjectMode = 'create';
	editingProjectId = null;
	$('modalProjectTitle').textContent = 'Novo projeto';
	$('projectNameInput').disabled = false;
	$('projectNameInput').value = 'Projeto ' + String(state.projects.length + 1).padStart(2, '0');
	$('projectSlugInput').value = slugify($('projectNameInput').value);
	$('projectSlugInput').disabled = false;
	$('projectRootInput').value = '';
	$('modalProject').style.display = 'flex';
	setTimeout(() => { $('projectNameInput').focus(); $('projectNameInput').select(); }, 50);
}


// Auto-preenche o slug enquanto o usuario digita o nome.
// Se o usuario editar o slug manualmente, para de auto-preencher.
(function () {
	let slugManual = false;
	const nameEl = document.getElementById('projectNameInput');
	const slugEl = document.getElementById('projectSlugInput');
	if (!nameEl || !slugEl) return;

	slugEl.addEventListener('input', () => {
		slugManual = slugEl.value.trim().length > 0;
	});
	nameEl.addEventListener('input', () => {
		if (slugManual) return;
		slugEl.value = slugify(nameEl.value);
	});

	// Ao abrir "Novo projeto", reset do flag
	const origOpen = window.openNewProject;
	// (o openNewProject ja seta o slug — mas o flag precisa resetar)
	const btn = document.getElementById('btnAddProject');
	if (btn) btn.addEventListener('click', () => { slugManual = false; });
})();



async function openPopup(chat) {
	if (!chat || !chat.uuid) return;
	try {
		const res = await window.projectsAPI.openSessionPopup(chat.uuid, chat.label);
		if (!res.ok) showDiag('Falha ao abrir popup: ' + res.error, false);
	} catch (e) { showDiag('Erro: ' + e.message, false); }
}

function ensureEmptyRemoved() {
	const em = $('emptyState');
	if (em) em.remove();
}

function clearTimeline() {
	const c = $('chatContent');
	c.innerHTML = '<div class="empty" id="emptyState">Sem mensagens ainda.<br>Envie uma tarefa abaixo para começar — a sessão é criada automaticamente.</div>';
	pendingCommands.clear();
	state.activeAssistantBlock = null;
	const comp = document.querySelector('.compacting');
	if (comp) comp.remove();
}

function scrollToBottom() {
	const t = $('timeline');
	if (t) t.scrollTop = t.scrollHeight;
}

function appendNode(node) {
	ensureEmptyRemoved();
	$('chatContent').appendChild(node);
	scrollToBottom();
}

function appendUserMessage(text) {
	const row = document.createElement('div');
	row.className = 'msg-row user';
	row.innerHTML = '<div class="user-bubble">' + escapeHtml(text) + '</div>';
	appendNode(row);
}



function appendAssistantMessage(text, time, opts) {
	opts = opts || {};
	const row = document.createElement('div');
	row.className = 'msg-row';
	const avatarHtml = '<div class="avatar"><svg class="i"><use href="#i-spark"/></svg></div>';
	const whoHtml = '<div class="who">DeepSeek Agent <span class="time">' + escapeHtml(time || timeNow()) + '</span></div>';
	const textHtml = '<div class="assistant-text">' + escapeHtml(text) + '</div>';

	let extraHtml = '';
	if (opts.needsReview) {
		const files = Array.isArray(opts.touchedFiles) ? opts.touchedFiles : [];
		const filesHtml = files.length > 0
			? '<div class="review-files">Arquivos: ' + files.map(function (f) { return escapeHtml(f); }).join(', ') + '</div>'
			: '';
		extraHtml =
			'<div class="review-btn-wrap">' +
				'<button class="review-btn" type="button" data-review="1">🤖 Pedir revisão ao agente</button>' +
				filesHtml +
			'</div>';
	}

	row.innerHTML = avatarHtml +
		'<div class="assistant-body">' +
			whoHtml + textHtml + extraHtml +
		'</div>';

	appendNode(row);

	if (opts.needsReview) {
		const btn = row.querySelector('[data-review]');
		if (btn) {
			btn.addEventListener('click', async () => {
				btn.disabled = true;
				btn.textContent = '🤖 Revisando…';
				await requestReview(opts);
			});
		}
	}
	return row;
}




// ============================================================
// Render de segmento do assistente (HTML ja preparado no loop)
// ============================================================
function appendAssistantSegment(html) {
	removeLiveStatus();
	const clean = sanitizeHtml(html || '');
	if (!clean) return null;

	const block = document.createElement('div');
	block.className = 'msg-row';
	block.innerHTML =
		'<div class="avatar"><svg class="i"><use href="#i-spark"/></svg></div>' +
		'<div class="assistant-body">' +
			'<div class="who">DeepSeek Agent <span class="time">' + escapeHtml(timeNow()) + '</span></div>' +
			'<div class="assistant-text markdown-body"></div>' +
		'</div>';
	appendNode(block);

	const textEl = block.querySelector('.assistant-text');
	if (textEl) textEl.innerHTML = clean;

	state.activeAssistantBlock = block;
	scrollToBottom();
	return block;
}

function resetActiveAssistantBlock() {
	state.activeAssistantBlock = null;
}

// ============================================================
// Sanitizacao de HTML (allowlist)
// ============================================================
const ALLOWED_TAGS = new Set([
  'p', 'div', 'span', 'br', 'hr',
  'ul', 'ol', 'li',
  'pre', 'code',
  'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'a', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'input',
  'img',
]);

const ALLOWED_CLASSES = new Set([
  'code-block',
  // marked-alert (caso o marked rode e gere os alertas)
  'markdown-alert',
  'markdown-alert-note',
  'markdown-alert-tip',
  'markdown-alert-important',
  'markdown-alert-warning',
  'markdown-alert-caution',
  'markdown-alert-title',
]);

function isAllowedClass(cls) {
  if (ALLOWED_CLASSES.has(cls)) return true;
  if (cls.indexOf('language-') === 0) return true;
  return false;
}

function enhanceCodeBlocks(root, doc) {
  const pres = Array.from(root.querySelectorAll('pre'));
  for (const pre of pres) {
    if (pre.parentElement && pre.parentElement.classList.contains('code-block')) continue;
    let lang = '';
    const prev = pre.previousElementSibling;
    if (prev) {
      const m = (prev.textContent || '').trim().match(/^([A-Za-z0-9_+#.-]*)\s*(?:Copy|Copiar)\s*(?:Download|Baixar)?$/i);
      if (m) { lang = m[1]; prev.remove(); }
    }
    if (!lang) {
      const code = pre.querySelector('code');
      const cm = code ? (code.className || '').match(/(?:^|\s)language-([A-Za-z0-9_+#.-]+)/) : null;
      if (cm) lang = cm[1];
    }
    const wrap = doc.createElement('div');
    wrap.className = 'code-block';
    const head = doc.createElement('div');
    head.className = 'code-head';
    const label = doc.createElement('span');
    label.className = 'code-lang';
    label.textContent = lang || 'c\u00f3digo';
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.textContent = 'Copiar';
    head.appendChild(label);
    head.appendChild(btn);
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(head);
    wrap.appendChild(pre);
    if (lang && window.highlightAPI) {
      let target = pre.querySelector('code');
      if (!target) {
        target = doc.createElement('code');
        target.textContent = pre.textContent;
        pre.textContent = '';
        pre.appendChild(target);
      }
      const out = window.highlightAPI.highlight(target.textContent, lang);
      if (typeof out === 'string' && out.length > 0) {
        target.innerHTML = out;
        target.classList.add('hljs');
      }
    }
  }
}

function sanitizeHtml(html) {
  let raw = String(html || '');
  raw = raw.replace(/<br\s*\/?>/gi, '\n');
  raw = raw.replace(/~~([\s\S]*?)~~/g, '<del>$1</del>');

  // Remove TODOS os <span>...</span> do DeepSeek antes de parsear.
  // O DeepSeek quebra comandos em vários spans, então o regex de
  // comando não casa no text node individual. Sem span, o texto
  // fica contínuo e o regex pega.
  // (Repetimos até não sobrar span aninhado.)
  for (let i = 0; i < 5; i++) {
    const antes = raw;
    raw = raw.replace(/<span\b[^>]*>/gi, '').replace(/<\/span>/gi, '');
    if (raw === antes) break;
  }

  const looksLikeHtml = /^\s*<(?:div|p|h[1-6]|ul|ol|table|pre|blockquote|section|article|header|footer)\b/i.test(raw);
  if (!looksLikeHtml && window.markdownAPI) {
    try {
      const md = window.markdownAPI.parse(raw);
      if (typeof md === 'string' && md.length > 0) raw = md;
    } catch (e) {}
  }

  const doc = new DOMParser().parseFromString('<div>' + raw + '</div>', 'text/html');
  const root = doc.body.firstChild;

  // Remove comandos <<<...>>> de qualquer texto (agora contínuo).
  const ALL_CMD_RE = /<<<[\s\S]*?>>>/g;

  // 1) Remove elementos cujo texto (sem comando e sem espaços) é vazio.
  const elems = root.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, pre, code');
  for (const el of Array.from(elems)) {
    const t = (el.textContent || '').trim();
    if (!t) continue;
    if (t.indexOf('<<<') === -1) continue;
    const semComando = t.replace(ALL_CMD_RE, '').replace(/\s+/g, '');
    if (semComando.length === 0) {
      el.remove();
    }
  }

  // 2) Nos text nodes restantes, remove comandos inline.
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const tn of textNodes) {
    const before = tn.nodeValue;
    if (!before || before.indexOf('<<<') === -1) continue;
    const after = before.replace(ALL_CMD_RE, '').replace(/[ \t]+\n/g, '\n');
    if (after !== before) tn.nodeValue = after;
  }

  // 3) Processa alertas via DOM.
  const bqs = root.querySelectorAll('blockquote');
  for (const bq of bqs) {
    const text = (bq.textContent || '').trim();
    const m = text.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i);
    if (!m) continue;
    const type = m[1].toUpperCase();
    const cls = 'markdown-alert markdown-alert-' + type.toLowerCase();
    const title = type.charAt(0) + type.slice(1).toLowerCase();
    const rest = text.slice(m[0].length).trim();
    const div = doc.createElement('div');
    div.className = cls;
    const pt = doc.createElement('p');
    pt.className = 'markdown-alert-title';
    pt.textContent = title;
    const pb = doc.createElement('p');
    pb.textContent = rest;
    div.appendChild(pt);
    div.appendChild(pb);
    bq.replaceWith(div);
  }

  function walk(node) {
    if (!node) return;
    if (node.nodeType === 3) return;
    if (node.nodeType !== 1) { node.remove(); return; }

    const tag = node.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) { node.remove(); return; }

    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) { node.removeAttribute(attr.name); continue; }
      if (name === 'href') {
        // ITEM 9: href so pode ser http:, https: ou mailto:.
        // Le o valor DECODIFICADO via getAttribute (nao o texto cru),
        // remove chars de controle/espace e testa. Se nao casar, remove.
        const decoded = node.getAttribute('href') || '';
        const clean = decoded.replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
        if (!/^(https?:|mailto:)/i.test(clean)) {
          node.removeAttribute('href');
        }
        continue;
      }
      if (name === 'target' || name === 'rel') continue;
      if (name === 'class') {
        const classes = attr.value.split(/\s+/).filter(function (c) { return isAllowedClass(c); });
        if (classes.length === 0) node.removeAttribute('class');
        else node.className = classes.join(' ');
        continue;
      }
      if (tag === 'input') {
        if (name === 'type' || name === 'checked' || name === 'disabled') continue;
        node.removeAttribute(attr.name);
        continue;
      }
      node.removeAttribute(attr.name);
    }

    if (tag === 'a' && node.getAttribute('target') === '_blank') {
      node.setAttribute('rel', 'noopener noreferrer');
    }

    for (const child of Array.from(node.childNodes)) walk(child);
  }

  for (const child of Array.from(root.childNodes)) walk(child);
  enhanceCodeBlocks(root, doc);
  return root.innerHTML;
}

function appendSessionMarker(text) {
	const d = document.createElement('div');
	d.className = 'session-marker';
	d.setAttribute('role', 'separator');
	d.innerHTML = '<span>' + escapeHtml(text) + '</span>';
	appendNode(d);
}

function appendCompacting() {
	const d = document.createElement('div');
	d.className = 'compacting';
	d.setAttribute('role', 'status');
	d.innerHTML =
		'<span class="pulse"></span>' +
		'<div>' +
			'<div class="compacting-title">Compactando sessão...</div>' +
			'<div class="compacting-desc">O contexto está sendo resumido em uma nova sessão.</div>' +
		'</div>';
	appendNode(d);
	return d;
}

function removeCompacting() {
	const c = document.querySelector('.compacting');
	if (c) c.remove();
}

function eventIconForType(type) {
	if (type === 'read') return 'i-file';
	if (type === 'run') return 'i-terminal';
	if (type === 'edit' || type === 'write') return 'i-diff';
	if (type === 'grep' || type === 'glob' || type === 'ls') return 'i-search';
	return 'i-file';
}

function eventTitleForCmd(cmd) {
	const type = cmd.type || '';
	const arg = cmd.arg || '';
	if (type === 'read') return 'Leitura de arquivo: <span class="mono-path">' + escapeHtml(arg) + '</span>';
	if (type === 'run') return 'Log de processo: <span class="mono-path">' + escapeHtml(arg || '(comando)') + '</span>';
	if (type === 'edit') return 'Alteração de código: <span class="mono-path">' + escapeHtml(arg) + '</span>';
	if (type === 'write') return 'Novo arquivo: <span class="mono-path">' + escapeHtml(arg) + '</span>';
	if (type === 'grep') return 'Busca: <span class="mono-path">' + escapeHtml(arg) + '</span>';
	if (type === 'glob') return 'Listagem: <span class="mono-path">' + escapeHtml(arg) + '</span>';
	if (type === 'ls') return 'Diretório: <span class="mono-path">' + escapeHtml(arg) + '</span>';
	return (type || 'cmd').toUpperCase() + (arg ? ': ' + escapeHtml(arg) : '');
}

function makeEventCard(cmdId, type) {
	const card = document.createElement('div');
	card.className = 'activity';
	const details = document.createElement('details');
	details.className = 'event-card';
	details.dataset.cmdId = cmdId;
	details.dataset.type = type;
	const summary = document.createElement('summary');
	summary.className = 'event-summary';
	summary.innerHTML =
		'<span class="event-icon"><svg class="i"><use href="#' + eventIconForType(type) + '"/></svg></span>' +
		'<span class="event-copy">' +
			'<span class="event-title"></span>' +
			'<span class="event-desc">aguardando resultado...</span>' +
		'</span>' +
		'<span class="event-trailing"><svg class="i"><use href="#i-chevron"/></svg></span>';
	const detail = document.createElement('div');
	detail.className = 'event-detail';
	details.appendChild(summary);
	details.appendChild(detail);
	card.appendChild(details);
	return card;
}

function addCommandCard(cmd) {
	const id = cmd.id || ('c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
	const card = makeEventCard(id, cmd.type);
	const title = card.querySelector('.event-title');
	title.innerHTML = eventTitleForCmd(cmd);
	appendNode(card);
	pendingCommands.set(id, { card, timer: setTimeout(() => {
		const entry = pendingCommands.get(id);
		if (!entry) return;
		const desc = entry.card.querySelector('.event-desc');
		if (desc) desc.textContent = '(sem resposta do executor)';
		pendingCommands.delete(id);
	}, 60000) });
	return card;
}

function renderDiff(diff) {
	let html = '';
	if (diff.removed && diff.removed.length) {
		for (const l of diff.removed) html += '<span class="diff-remove">- ' + escapeHtml(l) + '</span>';
	}
	if (diff.added && diff.added.length) {
		for (const l of diff.added) html += '<span class="diff-add">+ ' + escapeHtml(l) + '</span>';
	}
	if (!html) html = '<em style="color:#7f93ac">(sem alterações)</em>';
	return html;
}

function renderRunStreams(result) {
	let html = '<div class="streams">';
	if (result.stdout) html += '<div class="stream-block"><span class="stream-label">stdout</span><pre>' + escapeHtml(result.stdout) + '</pre></div>';
	if (result.stderr) html += '<div class="stream-block stderr"><span class="stream-label">stderr</span><pre>' + escapeHtml(result.stderr) + '</pre></div>';
	if (!result.stdout && !result.stderr) html += '<div class="stream-block"><pre>(sem saída)</pre></div>';
	const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
	const killed = !!result.killed;
	const exitLabel = killed
		? '⏱ Encerrado' + (result.signal ? ' — ' + result.signal : '')
		: (exitCode === 0 ? '✓ exit 0' : '✗ exit ' + exitCode);
	const cls = (exitCode === 0 && !killed) ? 'ok' : 'err';
	html += '<div class="exit-tag ' + cls + '">' + escapeHtml(exitLabel) + '</div>';
	html += '</div>';
	return html;
}

function attachResultToCard(card, result) {
	const desc = card.querySelector('.event-desc');
	const detail = card.querySelector('.event-detail');
	const trailing = card.querySelector('.event-trailing');
	const type = result.type || card.dataset.type;

	if (type === 'run' && typeof result.stdout === 'string') {
		if (desc) desc.textContent = result.ok ? 'Comando finalizado' : 'Comando falhou';
		if (detail) detail.innerHTML = renderRunStreams(result);
		if (trailing) {
			const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
			const killed = !!result.killed;
			const cls = (exitCode === 0 && !killed) ? 'good' : 'warn';
			const label = killed ? 'killed' : ('exit ' + exitCode);
			trailing.innerHTML = '<span class="tag ' + cls + '">' + escapeHtml(label) + '</span><svg class="i"><use href="#i-chevron"/></svg>';
		}
		return;
	}

	if (type === 'edit' || type === 'write') {
		if (result.diff) {
			if (desc) desc.textContent = (result.diff.added && result.diff.added.length) + ' linha(s) adicionada(s) · ' + (result.diff.removed && result.diff.removed.length) + ' removida(s)';
			if (detail) detail.innerHTML = renderDiff(result.diff);
			if (trailing) trailing.innerHTML = '<span class="tag warn">diff</span><svg class="i"><use href="#i-chevron"/></svg>';
			return;
		}
	}

	if (desc) desc.textContent = result.ok ? 'Concluído' : 'Erro';
	let content = stripProtocol(result.result || '');
	if (!content) content = '(sem conteúdo)';
	if (detail) detail.textContent = content;
	if (trailing && !result.ok) {
		trailing.innerHTML = '<span class="tag warn">erro</span><svg class="i"><use href="#i-chevron"/></svg>';
	}
}

function addResultCard(result) {
	if (result && result.type === 'message') {
		appendAssistantSegment(result.html || '');
		return;
	}
	const id = result.id;
	if (id && pendingCommands.has(id)) {
		const entry = pendingCommands.get(id);
		pendingCommands.delete(id);
		clearTimeout(entry.timer);
		attachResultToCard(entry.card.querySelector('.event-card') || entry.card, result);
		return;
	}
	const cmd = { id: id || ('c-' + Date.now()), type: result.type || 'system', arg: result.arg || '' };
	const card = addCommandCard(cmd);
	const ecard = card.querySelector('.event-card') || card;
	const cid = ecard.dataset.cmdId;
	if (cid && pendingCommands.has(cid)) {
		const entry = pendingCommands.get(cid);
		pendingCommands.delete(cid);
		clearTimeout(entry.timer);
	}
	attachResultToCard(ecard, result);
}

function applyStats(s) {
	if (!s) return;
	state.stats = s;
	state.running = !!s.running;
	$('statTasks').textContent = s.tasks;
	$('statMsgs').textContent = s.messages;
	$('statChars').textContent = fmtNum(s.chars);
	$('statTokens').textContent = fmtNum(s.approxTokens);

	const cWrap = $('statCharsWrap');
	const tWrap = $('statTokensWrap');
	cWrap.classList.remove('warn', 'danger');
	tWrap.classList.remove('warn', 'danger');
	if (s.approxTokens > TOKENS_DANGER) { cWrap.classList.add('danger'); tWrap.classList.add('danger'); }
	else if (s.approxTokens > TOKENS_WARN) { cWrap.classList.add('warn'); tWrap.classList.add('warn'); }

	updateCompactBanner(s);
	applyRunningState(s.running);

	if (typeof s.chatWindowVisible === 'boolean' && s.chatWindowVisible !== state.chatWindowVisible) {
		applyChatWindowState(s.chatWindowVisible);
	}
}

function updateCompactBanner(s) {
	const b = $('compactBanner');
	const msg = $('compactBannerMsg');
	const btn = $('compactBannerBtn');
	if (!s) { b.style.display = 'none'; return; }
	const danger = (s.approxTokens > TOKENS_DANGER) || (s.tasks >= TASKS_DANGER);
	const warn = (s.approxTokens > TOKENS_WARN) || (s.tasks >= TASKS_WARN);
	if (!warn && !danger) { b.style.display = 'none'; b.classList.remove('danger'); return; }
	b.style.display = 'flex';
	b.classList.toggle('danger', danger);

	if (s.running) {
		msg.textContent = '⏳ Compacte quando a tarefa terminar — ' + fmtNum(s.approxTokens) + ' tokens, ' + s.tasks + ' tarefa' + (s.tasks === 1 ? '' : 's');
		btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; btn.textContent = '⏳ Aguarde a tarefa';
	} else if (danger) {
		msg.textContent = '🔴 Compacte agora — ' + fmtNum(s.approxTokens) + ' tokens, ' + s.tasks + ' tarefa' + (s.tasks === 1 ? '' : 's');
		btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = ''; btn.textContent = '📦 Compactar agora';
	} else {
		msg.textContent = '⚠️ Hora de compactar — ' + fmtNum(s.approxTokens) + ' tokens, ' + s.tasks + ' tarefa' + (s.tasks === 1 ? '' : 's');
		btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = ''; btn.textContent = '📦 Compactar agora';
	}
}

function updateCompactButton(running) {
	const compactBtn = $('btnCompactNow');
	if (!compactBtn) return;
	const hasMessages = !!(state.stats && state.stats.messages > 0);
	compactBtn.disabled = !!running || !hasMessages;
}

function updateComposerState(running) {
	const noProject = !state.activeProjectId;
	$('messageInput').disabled = noProject;
	$('btnSend').disabled = !!running || noProject;
}

function applyRunningState(running) {
	const comp = $('composer');
	comp.classList.toggle('working', !!running);
	updateComposerState(running);
	updateCompactButton(running);
	const btn = $('compactBannerBtn');
	const msg = $('compactBannerMsg');
	const b = $('compactBanner');
	if (btn && b && b.style.display === 'flex') {
		if (running) {
			btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; btn.textContent = '⏳ Aguarde a tarefa';
			if (msg && state.stats) {
				msg.textContent = '⏳ Compacte quando a tarefa terminar — ' + fmtNum(state.stats.approxTokens) + ' tokens, ' + state.stats.tasks + ' tarefa' + (state.stats.tasks === 1 ? '' : 's');
			}
		} else if (state.stats) {
			updateCompactBanner(state.stats);
		}
	}
}

function appendLiveStatus(text) {
	const row = document.createElement('div');
	row.className = 'msg-row live-status';
	row.innerHTML =
		'<div class="avatar"><svg class="i"><use href="#i-spark"/></svg></div>' +
		'<div class="assistant-body">' +
		'<div class="who">DeepSeek Agent <span class="time">' + escapeHtml(timeNow()) + '</span></div>' +
		'<div class="live-status-text">' + escapeHtml(text) + '<span class="dots">…</span></div>' +
		'</div>';
	appendNode(row);
	return row;
}

function updateLiveStatus(text) {
	const el = document.querySelector('.live-status .live-status-text');
	if (!el) return;
	el.innerHTML = escapeHtml(text) + '<span class="dots">…</span>';
}

function removeLiveStatus() {
	const el = document.querySelector('.live-status');
	if (el) el.remove();
}

function applyChatWindowState(visible) {
	state.chatWindowVisible = !!visible;
	const dot = $('statusDot');
	const txt = $('engineStatus');
	if (visible) { dot.classList.remove('off'); txt.textContent = 'DeepSeek conectado'; }
	else { dot.classList.add('off'); txt.textContent = 'DeepSeek oculto'; }
}

async function executeRun(task, opts) {
	opts = opts || {};
	const displayUserText = opts.displayUserText || task;
	const project = state.projects.find(p => p.id === state.activeProjectId);
	const projectRoot = project ? project.projectRoot : '';

	$('messageInput').value = '';
	clearPendingTimers();
	resetActiveAssistantBlock();
	appendUserMessage(displayUserText);
	appendLiveStatus('Iniciando agente');

	state.running = true;
	applyRunningState(true);

	try {
		const res = await window.agentAPI.run(task, projectRoot);
		if (!res.ok) {
			removeLiveStatus();
			appendAssistantMessage('❌ ERRO: ' + res.error, timeNow());
		} else if (res.result && res.result.aborted) {
			removeLiveStatus();
			appendAssistantMessage('⚠️ ABORTADO em ' + res.result.turns + ' turnos.\n\n' + (res.result.summary || ''), timeNow());
		} else {
			const summary = res.result.summary || '';

			// Conta quantos blocos de assistente o loop.js JA renderizou no DOM.
			// Se for 0, renderiza o summary (fallback). Se for >=1, nao duplica.
			const blocksRendered = document.querySelectorAll('#chatContent .assistant-text').length;

			if (blocksRendered === 0 && summary) {
				const row = appendAssistantMessage('', timeNow(), {
					needsReview: !!res.result.needsReview,
					touchedFiles: res.result.touchedFiles || [],
					reviewPrompt: res.result.reviewPrompt || '',
					originalTask: opts.originalTask || task,
				});
				const textEl = row ? row.querySelector('.assistant-text') : null;
				if (textEl) {
					textEl.classList.add('markdown-body');
					textEl.innerHTML = sanitizeHtml(summary);
					scrollToBottom();
				}
			} else if (blocksRendered > 0 && res.result.needsReview) {
				// Se precisa revisao, adiciona o botao no ULTIMO bloco renderizado
				const blocks = document.querySelectorAll('#chatContent .assistant-text');
				const lastBlock = blocks[blocks.length - 1];
				const body = lastBlock ? lastBlock.closest('.assistant-body') : null;
				if (body && !body.querySelector('.review-btn')) {
					const files = (res.result.touchedFiles || []);
					const filesHtml = files.length > 0
						? '<div class="review-files">Arquivos: ' + files.map(function (f) { return escapeHtml(f); }).join(', ') + '</div>'
						: '';
					const wrap = document.createElement('div');
					wrap.className = 'review-btn-wrap';
					wrap.innerHTML = '<button class="review-btn" type="button">🤖 Pedir revisão ao agente</button>' + filesHtml;
					body.appendChild(wrap);
					const btn = wrap.querySelector('.review-btn');
					if (btn) {
						btn.addEventListener('click', async () => {
							btn.disabled = true;
							btn.textContent = '🤖 Revisando…';
							await requestReview({
								needsReview: true,
								touchedFiles: files,
								reviewPrompt: res.result.reviewPrompt || '',
								originalTask: opts.originalTask || task,
							});
						});
					}
				}
			}
		}
		if (res.stats) applyStats(res.stats);
		if (res.state) applyState(res.state);
	} catch (e) {
		removeLiveStatus();
		appendAssistantMessage('❌ ERRO: ' + e.message, timeNow());
	} finally {
		removeLiveStatus();
		state.running = false;
		applyRunningState(false);
		clearPendingTimers();
		try { await persistTimeline(); } catch (e) {}
	}
}
async function runTask() {
	const t = $('messageInput').value.trim();
	if (!t) return;
	if (state.running) return;
	if (!state.activeProjectId) return alert('Crie um projeto primeiro.');
	const project = state.projects.find(p => p.id === state.activeProjectId);
	const projectRoot = project ? project.projectRoot : '';
	if (!projectRoot) return alert('Defina a pasta raiz do projeto (menu do projeto → Alterar pasta raiz).');
	await executeRun(t, { displayUserText: t });
}

async function requestReview(data) {
	if (!data || !data.reviewPrompt) {
		showDiag('Não foi possível montar o prompt de revisão.', false);
		return;
	}
	if (state.running) return;
	await executeRun(data.reviewPrompt, {
		displayUserText: '🤖 Pedir revisão ao agente (arquivos: ' +
			(data.touchedFiles && data.touchedFiles.length ? data.touchedFiles.join(', ') : '—') + ')',
		originalTask: data.originalTask || '',
	});
}

async function stopTask() {
	if (!state.running) return;
	try { await window.agentAPI.abort(); } catch (e) { showDiag('Erro ao parar: ' + e.message, false); }
}

async function doCompact() {
	if (state.running) return;
	if (!confirm('Compactar a sessão atual?\n\nO app vai:\n• pedir um resumo ao modelo\n• criar uma nova sessão no DeepSeek\n• reinjetar o resumo na nova sessão\n\nA sessão anterior fica no histórico (Sessions) para consulta.')) return;
	appendCompacting();
	try {
		const res = await window.agentAPI.compact();
		removeCompacting();
		if (!res.ok) {
			appendAssistantMessage('❌ Compactação falhou: ' + res.error, timeNow());
		} else {
			clearTimeline();
			appendSessionMarker('Nova sessão (compactada) · ' + timeNow());
			showDiag('Nova sessão criada com o resumo da anterior.', true);
		}
		if (res.stats) applyStats(res.stats);
		try { const st = await window.projectsAPI.state(); applyState(st); await persistTimeline(); } catch (e) {}
	} catch (e) {
		removeCompacting();
		appendAssistantMessage('❌ ERRO: ' + e.message, timeNow());
	}
}

function updateRunBatchCount() {
	const count = document.querySelectorAll('#runModalList input[data-role="main"]:checked').length;
	$('runModalCount').textContent = count;
	$('runModalRun').disabled = count === 0;
}

function showRunBatchModal(items) {
	pendingRunBatch = { items };
	const list = $('runModalList');
	list.innerHTML = '';
	items.forEach((item, i) => {
		const row = document.createElement('div');
		row.className = 'cmd-item';
		row.dataset.idx = i;

		// ITEM 11: WRITE/EDIT sensivel entra no mesmo modal do RUN, mas com
		// rotulo diferente e SEM checkbox "Sempre permitir". O path vai via
		// textContent (nunca innerHTML).
		const isSensitiveWrite = (item.kind === 'write' || item.kind === 'edit') && item.sensitive === true;

		const code = document.createElement('code');
		code.className = 'cmd';
		code.textContent = isSensitiveWrite
			? ('GRAVAR: ' + (item.path || item.cmd || ''))
			: String(item.cmd || '');
		row.appendChild(code);

		if (isSensitiveWrite) {
			const reason = document.createElement('div');
			reason.style.cssText = 'display:inline-block;margin-top:6px;padding:2px 8px;background:#3c2a12;color:#fcd9a3;border:1px solid #6a5735;border-radius:4px;font-size:10px;font-weight:600';
			reason.textContent = '⚠ ARQUIVO SENSÍVEL' + (item.danger ? ': ' + item.danger : '');
			row.appendChild(reason);

			const mainLabel = document.createElement('label');
			mainLabel.className = 'allow';
			const mainCb = document.createElement('input');
			mainCb.type = 'checkbox';
			mainCb.setAttribute('data-role', 'main');
			mainCb.setAttribute('data-idx', String(i));
			mainCb.checked = true;
			mainLabel.appendChild(mainCb);
			mainLabel.appendChild(document.createTextNode(' Gravar'));
			row.appendChild(mainLabel);
		} else {
			if (!item.danger) {
				const alwaysLabel = document.createElement('label');
				alwaysLabel.className = 'allow';
				const alwaysCb = document.createElement('input');
				alwaysCb.type = 'checkbox';
				alwaysCb.setAttribute('data-role', 'always');
				alwaysCb.setAttribute('data-idx', String(i));
				alwaysLabel.appendChild(alwaysCb);
				alwaysLabel.appendChild(document.createTextNode(' Sempre permitir'));
				row.appendChild(alwaysLabel);
			}

			const mainLabel2 = document.createElement('label');
			mainLabel2.className = 'allow';
			const mainCb2 = document.createElement('input');
			mainCb2.type = 'checkbox';
			mainCb2.setAttribute('data-role', 'main');
			mainCb2.setAttribute('data-idx', String(i));
			mainCb2.checked = true;
			mainLabel2.appendChild(mainCb2);
			mainLabel2.appendChild(document.createTextNode(' Executar'));
			row.appendChild(mainLabel2);

			if (item.danger) {
				const d = document.createElement('div');
				d.className = 'run-item-danger-badge';
				d.style.cssText = 'display:inline-block;margin-top:6px;padding:2px 8px;background:#7f1d1d;color:#fecaca;border-radius:4px;font-size:10px;font-weight:700;text-transform:uppercase';
				d.textContent = '⚠ PERIGOSO: ' + item.danger;
				row.appendChild(d);
			}
		}

		list.appendChild(row);
	});
	updateRunBatchCount();
	$('runModal').style.display = 'flex';
}

function hideRunBatchModal() {
	$('runModal').style.display = 'none';
	pendingRunBatch = null;
}

$('runModalDeny').addEventListener('click', () => {
	if (!pendingRunBatch) return;
	window.agentAPI.sendRunBatchResponse({ approved: [], always: [] });
	hideRunBatchModal();
});
$('runModalRun').addEventListener('click', () => {
	if (!pendingRunBatch) return;
	const approved = [], always = [];
	document.querySelectorAll('#runModalList input[data-role="main"]').forEach(cb => {
		if (cb.checked) {
			const idx = parseInt(cb.dataset.idx, 10);
			approved.push(idx);
			// ITEM 11: "Sempre permitir" nunca e' coletado para item sensivel
			// (o main.js tambem filtra como defesa em profundidade).
			const it = pendingRunBatch.items[idx];
			if (it && it.sensitive === true) return;
			const a = document.querySelector('#runModalList input[data-role="always"][data-idx="' + idx + '"]');
			if (a && a.checked) always.push(idx);
		}
	});
	window.agentAPI.sendRunBatchResponse({ approved, always });
	hideRunBatchModal();
});

$('modalProjectCancel').addEventListener('click', () => { 
	$('modalProject').style.display = 'none'; 
});

$('modalProjectSave').addEventListener('click', async () => {
	const name = $('projectNameInput').value.trim();
	const slug = slugify($('projectSlugInput').value || name);
	const root = $('projectRootInput').value.trim();

	if (modalProjectMode === 'editRoot') {
		if (!editingProjectId) return;
		$('modalProject').style.display = 'none';
		const res = await window.projectsAPI.setRoot(editingProjectId, root);
		if (!res.ok) { alert('Erro: ' + res.error); return; }
		const st = await window.projectsAPI.state();
		applyState(st);
		return;
	}

	if (!name) return alert('Digite o nome do projeto.');
	if (!slug) return alert('Digite um slug válido (letras, números e hífen).');

	if (creatingProject) return;
	creatingProject = true;
	$('modalProject').style.display = 'none';
	try {
		const res = await window.projectsAPI.create({ name, slug, projectRoot: root });
		if (!res.ok) { alert('Erro: ' + res.error); return; }
		clearTimeline();
		applyState(res.state);
		try { await restoreHistory(); } catch (e) {}
		if (res.stats) applyStats(res.stats);
	} finally {
		creatingProject = false;
	}
});

$('btnPickRoot').addEventListener('click', async () => {
	try {
		const folder = await window.agentAPI.pickFolder();
		if (folder) $('projectRootInput').value = folder;
	} catch (e) {}
});

$('modalRenameCancel').addEventListener('click', () => { $('modalRename').style.display = 'none'; });
$('modalRenameSave').addEventListener('click', async () => {
	const name = $('renameInput').value.trim();
	if (!name) return alert('Digite um nome.');
	const mode = $('modalRename').dataset.mode;
	const id = $('modalRename').dataset.id;
	if (mode === 'project') {
		const res = await window.projectsAPI.rename(id, name);
		if (!res.ok) return alert('Erro: ' + res.error);
	} else if (mode === 'chat') {
		const res = await window.projectsAPI.renameChat(state.activeProjectId, id, name);
		if (!res.ok) return alert('Erro (local): ' + res.error);
		const remote = $('renameRemote').checked;
		if (remote) {
			showOverlay('Renomeando no DeepSeek…', 'Aguarde.');
			try {
				const r = await window.projectsAPI.renameChatRemote(id, name);
				hideOverlay();
				if (!r || !r.ok) {
					const msg = (r && (r.text || r.error)) || 'erro desconhecido';
					showDiag('Falha ao renomear no DeepSeek: ' + msg, false);
				}
			} catch (e) { hideOverlay(); showDiag('Erro ao renomear no DeepSeek: ' + e.message, false); }
		}
	}
	$('modalRename').style.display = 'none';
	const st = await window.projectsAPI.state();
	applyState(st);
});

$('modalDeleteCancel').addEventListener('click', () => {
	$('modalDelete').style.display = 'none';
	pendingDelete = null;
	$('modalDeleteRemote').disabled = false;
});

$('modalDeleteConfirm').addEventListener('click', async () => {
	if (!pendingDelete) return;
	const remote = !!$('modalDeleteRemote').checked && !$('modalDeleteRemote').disabled;

	if (pendingDelete.type === 'project') {
		if (remote) showOverlay('Removendo projeto…', 'Apagando sessões no DeepSeek. Aguarde.');
		try {
			const res = await window.projectsAPI.delete(pendingDelete.id, remote);
			if (remote) hideOverlay();
			if (!res.ok) {
				if (remote) {
					if (res.needsLogin) {
						hideOverlay();
						showDiag('Sua sessão do DeepSeek expirou. Faça login de novo e tente apagar.', false, {
							actionLabel: 'Abrir DeepSeek',
							onAction: async () => { try { await window.agentAPI.toggleChat(); } catch (e) {} },
							duration: 12000,
						});
					} else {
						overlayError(res.error || 'Falha ao remover projeto.', () => {
							try {
								window.projectsAPI.delete(pendingDelete.id, true).then(r => {
									if (!r.ok) overlayError(r.error || 'Falha.', null);
									else { hideOverlay(); clearTimeline(); applyState(r.state); if (r.stats) applyStats(r.stats); }
								});
							} catch (e) {}
						});
					}
				} else { alert('Erro: ' + res.error); }
				$('modalDelete').style.display = 'none';
				pendingDelete = null;
				$('modalDeleteRemote').disabled = false;
				return;
			}
			clearTimeline();
			applyState(res.state);
			try { await restoreHistory(); } catch (e) {}
			if (res.stats) applyStats(res.stats);
		} catch (e) { if (remote) hideOverlay(); alert('Erro: ' + e.message); }
		$('modalDelete').style.display = 'none';
		pendingDelete = null;
		$('modalDeleteRemote').disabled = false;
		return;
	}

	const uuid = pendingDelete.id;
	const wasActive = (uuid === state.activeChatUuid);
	if (remote) showOverlay('Removendo sessão…', 'Apagando no DeepSeek. Aguarde.');

	try {
		const res = await window.projectsAPI.deleteChat(state.activeProjectId, uuid, remote);
		if (remote) hideOverlay();
		if (!res.ok) {
			if (remote) {
				if (res.needsLogin) {
					hideOverlay();
					showDiag('Sua sessão do DeepSeek expirou. Faça login de novo e tente apagar.', false, {
						actionLabel: 'Abrir DeepSeek',
						onAction: async () => { try { await window.agentAPI.toggleChat(); } catch (e) {} },
						duration: 12000,
					});
				} else {
					overlayError(res.error || 'Falha ao remover sessão.', () => {
						try {
							window.projectsAPI.deleteChat(state.activeProjectId, uuid, true).then(r => {
								if (!r.ok) overlayError(r.error || 'Falha.', null);
								else { hideOverlay(); if (wasActive) clearTimeline(); applyState(r.state); if (r.stats) applyStats(r.stats); }
							});
						} catch (e) {}
					});
				}
			} else { alert('Erro: ' + res.error); }
			$('modalDelete').style.display = 'none';
			pendingDelete = null;
			$('modalDeleteRemote').disabled = false;
			return;
		}
		if (res.needsLogin) {
			showDiag('Sua sessão do DeepSeek expirou. Faça login de novo e tente apagar.', false, {
				actionLabel: 'Abrir DeepSeek',
				onAction: async () => { try { await window.agentAPI.toggleChat(); } catch (e) {} },
				duration: 12000,
			});
		}
		if (wasActive) clearTimeline();
		applyState(res.state);
		if (wasActive) { try { await restoreHistory(); } catch (e) {} }
		if (res.stats) applyStats(res.stats);
	} catch (e) { if (remote) hideOverlay(); alert('Erro: ' + e.message); }
	$('modalDelete').style.display = 'none';
	pendingDelete = null;
	$('modalDeleteRemote').disabled = false;
});

$('btnAddProject').addEventListener('click', openNewProject);
$('btnOpenDeepSeek').addEventListener('click', async () => {
	try {
		const res = await window.agentAPI.toggleChat();
		if (res && typeof res.visible === 'boolean') applyChatWindowState(res.visible);
	} catch (e) { showDiag('Erro ao alternar DeepSeek: ' + e.message, false); }
});
$('btnCompactNow').addEventListener('click', doCompact);
$('compactBannerBtn').addEventListener('click', doCompact);
$('sessionFilter').addEventListener('input', renderChats);
$('btnSend').addEventListener('click', runTask);
$('btnStop').addEventListener('click', stopTask);
$('messageInput').addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runTask(); }
});
document.addEventListener('click', (e) => {
	const wrap = $('sessionsWrap');
	if (wrap && wrap.open && !wrap.contains(e.target)) wrap.open = false;
});

document.addEventListener('click', async (e) => {
	const btn = e.target && e.target.closest ? e.target.closest('.code-copy') : null;
	if (!btn) return;
	const box = btn.closest('.code-block');
	const pre = box ? box.querySelector('pre') : null;
	if (!pre) return;
	try {
		await navigator.clipboard.writeText(pre.textContent || '');
		btn.textContent = 'Copiado \u2713';
	} catch (err) {
		btn.textContent = 'Falhou';
	}
	setTimeout(() => { btn.textContent = 'Copiar'; }, 1500);
});

window.agentAPI.onCommand((cmd) => {
	const statusText = {
		read: 'Lendo ' + (cmd.arg || ''),
		edit: 'Editando ' + (cmd.arg || ''),
		write: 'Criando ' + (cmd.arg || ''),
		run: 'Executando comando',
		ls: 'Listando ' + (cmd.arg || ''),
		glob: 'Buscando arquivos',
		grep: 'Buscando texto',
	}[cmd.type];
	if (statusText) updateLiveStatus(statusText);
	addCommandCard(cmd);
});

window.agentAPI.onResult((r) => {
	if (r && r.type !== 'message' && document.querySelector('.live-status')) {
		updateLiveStatus('Analisando resposta');
	}
	addResultCard(r);
});

window.agentAPI.onStats((s) => { applyStats(s); });
window.agentAPI.onChatWindowState((data) => { applyChatWindowState(data.visible); });
window.agentAPI.onRunBatchRequest((data) => {
	if (!data || !Array.isArray(data.items)) return;
	showRunBatchModal(data.items);
});
window.agentAPI.onLog((msg) => {
	if (!msg) return;
	const internalPrefixes = ['[main]', 'compact:', 'runAgent ', 'turno ', 'executando ', 'enviando ', 'resposta recebida', 'turn0 tamanho', 'RUNs aguardando', 'confirmado:', 'RUN sempre-aprovado', 'askAndLog:', 'abortado ', 'abort solicitado', 'DONE'];
	if (internalPrefixes.some(p => msg.indexOf(p) === 0)) {
		console.log('[agent log]', msg);
		return;
	}
	if (msg.startsWith('❌') || msg.indexOf('ERRO') !== -1) showDiag(msg, false);
	else if (msg.startsWith('✅')) showDiag(msg, true);
	else console.log('[agent]', msg);
});

window.projectsAPI.onChanged((st) => { applyState(st); });

// ============================================================
// Persistencia e restauracao do historico visual
// ============================================================
async function persistTimeline() {
  const projectId = state.activeProjectId;
  const chatId = state.activeChatUuid;
  if (!projectId || !chatId) return;
  if (!window.historyAPI) return;

  const content = $('chatContent');
  if (!content) return;

  const entries = [];
  const nodes = [];
  const children = content.children;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (!node || node.dataset.hist === '1') continue;
    if (node.id === 'emptyState') continue;
    if (node.classList.contains('compacting')) continue;
    if (node.classList.contains('live-status')) continue;
    if (node.classList.contains('history-more')) continue;

    let kind = 'assistant';
    if (node.classList.contains('msg-row') && node.classList.contains('user')) kind = 'user';
    else if (node.classList.contains('activity')) kind = 'event';
    else if (node.classList.contains('session-marker')) kind = 'system';
    else if (node.classList.contains('msg-row')) kind = 'assistant';
    else continue;

    const clone = node.cloneNode(true);
    const reviewBtn = clone.querySelector('.review-btn');
    if (reviewBtn) reviewBtn.remove();
    const detailsList = clone.querySelectorAll('details[open]');
    for (const d of detailsList) d.removeAttribute('open');

    entries.push({ t: Date.now(), kind, html: clone.outerHTML });
    nodes.push(node);
  }

  if (!entries.length) return;

  try {
    const res = await window.historyAPI.append(projectId, chatId, entries);
    if (res && res.ok) {
      for (const node of nodes) node.dataset.hist = '1';
    }
  } catch (e) {}
}

// Limpeza minima (sem allowlist) para restaurar HTML ja gravado.
function cleanHistoryNode(node) {
  if (!node || node.nodeType !== 1) return node;
  const bad = node.querySelectorAll('script, iframe, object, embed');
  for (const el of Array.from(bad)) el.remove();
  const all = [node].concat(Array.from(node.querySelectorAll('*')));
  for (const el of all) {
    if (el.nodeType !== 1) continue;
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.indexOf('on') === 0) { el.removeAttribute(attr.name); continue; }
      if (name === 'href' || name === 'src') {
        const val = (el.getAttribute(attr.name) || '').trim().toLowerCase();
        if (val.indexOf('javascript:') === 0) el.removeAttribute(attr.name);
      }
    }
  }
  return node;
}

function entryToNode(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  const node = template.content.firstElementChild;
  if (!node) return null;
  return cleanHistoryNode(node);
}

async function restoreHistory() {
  const projectId = state.activeProjectId;
  const chatId = state.activeChatUuid;
  if (!projectId || !chatId) return;
  if (!window.historyAPI) return;

  try {
    const res = await window.historyAPI.readLast(projectId, chatId);
    if (!res || !Array.isArray(res.entries) || res.entries.length === 0) return;

    ensureEmptyRemoved();
    const content = $('chatContent');
    for (const entry of res.entries) {
      const node = entryToNode(entry.html);
      if (!node) continue;
      node.dataset.hist = '1';
      content.appendChild(node);
    }
    scrollToBottom();

    state.histPage = res.page || 1;
    state.histTotal = res.totalPages || 1;

    if (state.histTotal > 1 && state.histPage > 1) {
      insertHistoryMoreButton();
    }
  } catch (e) {}
}

function insertHistoryMoreButton() {
  const content = $('chatContent');
  if (!content) return;
  if (content.querySelector('.history-more')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'history-more';
  btn.textContent = 'Carregar mensagens anteriores';
  btn.addEventListener('click', loadPreviousHistoryPage);
  content.insertBefore(btn, content.firstChild);
}

async function loadPreviousHistoryPage() {
  const projectId = state.activeProjectId;
  const chatId = state.activeChatUuid;
  if (!projectId || !chatId) return;
  if (!window.historyAPI) return;
  const btn = document.querySelector('#chatContent .history-more');
  if (!btn) return;
  const targetPage = state.histPage - 1;
  if (targetPage < 1) { btn.remove(); return; }

  try {
    const res = await window.historyAPI.readPage(projectId, chatId, targetPage);
    if (!res || !Array.isArray(res.entries) || res.entries.length === 0) {
      btn.remove();
      return;
    }
    const content = $('chatContent');
    const timeline = $('timeline');
    const prevHeight = timeline ? timeline.scrollHeight : 0;

    for (const entry of res.entries) {
      const node = entryToNode(entry.html);
      if (!node) continue;
      node.dataset.hist = '1';
      content.insertBefore(node, btn);
    }

    state.histPage = targetPage;
    if (state.histPage <= 1) btn.remove();

    if (timeline) {
      const newHeight = timeline.scrollHeight;
      timeline.scrollTop = timeline.scrollTop + (newHeight - prevHeight);
    }
  } catch (e) {}
}