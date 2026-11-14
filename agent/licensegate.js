// agent/licensegate.js
// Estado da licenca no app: validacao no boot, janela de tolerancia de 1 minuto,
// travamento e checkout. NAO depende de Electron: o main.js liga os callbacks.
//
// Fases:
//   checking -> validando a licenca (boot)
//   trial    -> teste gratis de 7 dias (controlado pelo Worker); app liberado
//   valid    -> liberado (licenca paga)
//   grace    -> sem licenca valida; barra de 1 min correndo; pode usar o app
//   locked   -> tolerancia esgotada; agent:run bloqueado; modal forcado
// Fechar o modal estando 'locked' abre uma nova tolerancia de 1 minuto.

const license = require('./license');

const GRACE_MS = 60 * 1000;
const RETRY_MS = 30 * 1000;
const REVALIDATE_MS = 30 * 60 * 1000;   // reconfere licenca/teste com o app aberto
const TRIAL_TOTAL_MS = 7 * 24 * 60 * 60 * 1000;

let cb = { onState: null, onLock: null };
let phase = 'checking';
let reason = null;          // 'no_license' | 'invalid' | 'offline' | 'trial_expired' | null
let expiresAt = 0;          // fim do teste (epoch ms), so quando phase === 'trial'
let revalTimer = null;
let expiryTimer = null;
let message = '';
let deadline = 0;
let showModal = false;
let lockTimer = null;
let retryTimer = null;
let activating = false;
let bootStarted = false;

function snapshot() {
    return {
        phase: phase,
        reason: reason,
        message: message,
        showModal: showModal,
        graceMs: GRACE_MS,
        remainingMs: phase === 'grace' ? Math.max(0, deadline - Date.now()) : 0,
        trialRemainingMs: phase === 'trial' ? Math.max(0, expiresAt - Date.now()) : 0,
        trialTotalMs: TRIAL_TOTAL_MS,
        minValue: license.MIN_VALUE,
    };
}

function emit() {
    if (!cb.onState) return;
    try { cb.onState(snapshot()); } catch (e) { /* ignora */ }
}

function clearTimers() {
    if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
}

function init(opts) {
    opts = opts || {};
    cb.onState = opts.onState || null;
    cb.onLock = opts.onLock || null;
    license.init(opts.userDataDir);
}

function stopReval() {
    if (revalTimer) { clearInterval(revalTimer); revalTimer = null; }
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
}

// Reconfere com o Worker (licenca bloqueada, teste vencido). Offline = nao pune.
async function revalidate() {
    if (phase !== 'valid' && phase !== 'trial') return;
    let r;
    try { r = await evaluate(); } catch (e) { return; }
    if (r.status === 'offline') return;
    if (phase !== 'valid' && phase !== 'trial') return;
    applyValidation(r);
}

function startReval() {
    stopReval();
    revalTimer = setInterval(revalidate, REVALIDATE_MS);
    if (phase === 'trial' && expiresAt) {
        const ms = Math.min(Math.max(expiresAt - Date.now() + 2000, 1000), 2147000000);
        expiryTimer = setTimeout(revalidate, ms);
    }
}

function setTrial(exp) {
    clearTimers();
    const keepModal = phase === 'trial' && showModal;   // nao fecha o modal se o usuario esta pagando
    phase = 'trial';
    reason = null;
    message = '';
    deadline = 0;
    expiresAt = exp || 0;
    showModal = keepModal;
    emit();
    startReval();
}

function setValid() {
    clearTimers();
    phase = 'valid';
    expiresAt = 0;
    reason = null;
    message = '';
    deadline = 0;
    showModal = false;
    emit();
    startReval();
}

function lock() {
    lockTimer = null;
    if (phase !== 'grace') return;
    phase = 'locked';
    showModal = true;
    deadline = 0;
    emit();
    if (cb.onLock) {
        try { cb.onLock(); } catch (e) { /* ignora */ }
    }
}

function startGrace(withModal) {
    stopReval();
    expiresAt = 0;
    if (lockTimer) clearTimeout(lockTimer);
    phase = 'grace';
    showModal = !!withModal;
    deadline = Date.now() + GRACE_MS;
    lockTimer = setTimeout(lock, GRACE_MS);
    emit();
}

function startRetry() {
    if (retryTimer) return;
    retryTimer = setInterval(async () => {
        try {
            const r = await evaluate();
            if (r.status === 'valid') applyValidation(r);
        } catch (e) { /* tenta de novo */ }
    }, RETRY_MS);
}

// Valida a licenca; sem licenca, tenta iniciar o teste gratis (1 por maquina).
async function evaluate() {
    const r = await license.validate();
    if (r.status !== 'no_license') return r;

    const t = await license.startTrial();
    if (t.ok) return license.validate();
    if (t.offline) return { status: 'offline' };
    if (t.trialUsed) return { status: 'invalid', trialExpired: true, error: t.error };
    return { status: 'no_license', error: t.error };
}

function applyValidation(r) {
    if (r.status === 'valid') {
        if (r.plan === 'trial') return setTrial(r.expiresAt);
        return setValid();
    }

    reason = r.status === 'offline' ? 'offline'
        : (r.trialExpired ? 'trial_expired'
            : (r.status === 'invalid' ? 'invalid' : 'no_license'));
    message = r.error || '';
    startGrace(false);
    if (reason === 'offline') startRetry();
}

// ------------------------------------------------------------
// API
// ------------------------------------------------------------
async function boot() {
    if (bootStarted) return;
    bootStarted = true;
    phase = 'checking';
    emit();
    let r;
    try {
        r = await evaluate();
    } catch (e) {
        r = { status: 'offline' };
    }
    applyValidation(r);
}

function getState() {
    return snapshot();
}

// { ok: true } | { ok: false, error }
function allowRun() {
    if (phase === 'valid' || phase === 'trial' || phase === 'grace') return { ok: true };
    if (phase === 'checking') return { ok: false, error: 'Validando a licença… tente novamente em instantes.' };
    return { ok: false, error: 'Licença necessária para executar tarefas.' };
}

function open() {
    if (phase === 'valid' || phase === 'checking') return;
    showModal = true;
    emit();
}

function dismiss() {
    if (phase === 'locked') return startGrace(false);
    if (phase === 'grace' || phase === 'trial') {
        showModal = false;
        emit();
    }
}

async function startCheckout(valor, payer) {
    if (phase === 'valid') return { ok: false, error: 'Este app já está licenciado.' };
    return license.createCheckout(valor, payer);
}

// Consulta o pagamento. Quando confirmado, ativa e libera o app sozinho.
// Retorna { status: 'PENDING' | 'NOT_FOUND' | 'ERROR', error? } ou { status: 'RECEIVED', unlocked: true }
async function pollCheckout(cobrancaId) {
    if (activating) return { status: 'PENDING' };
    const s = await license.checkoutStatus(cobrancaId);
    if (s.status !== 'RECEIVED' || !s.activation_code) return s;

    activating = true;
    try {
        const a = await license.activate(s.activation_code);
        if (!a.ok) return { status: 'ERROR', error: a.error };
        const v = await license.validate();
        if (v.status !== 'valid') return { status: 'ERROR', error: v.error || 'Não foi possível validar a licença.' };
        setValid();
        return { status: 'RECEIVED', unlocked: true };
    } finally {
        activating = false;
    }
}

// Ativacao manual por codigo. { ok: true } | { ok: false, error }
async function activateCode(code) {
    if (activating) return { ok: false, error: 'Ativação em andamento.' };
    activating = true;
    try {
        const a = await license.activate(code);
        if (!a.ok) return a;
        const v = await license.validate();
        if (v.status !== 'valid') return { ok: false, error: v.error || 'Não foi possível validar a licença.' };
        setValid();
        return { ok: true };
    } finally {
        activating = false;
    }
}

function stop() {
    clearTimers();
    stopReval();
}

module.exports = { init, boot, getState, allowRun, open, dismiss, startCheckout, pollCheckout, activateCode, stop };