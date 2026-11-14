// agent/license.js
// Licenciamento: fingerprint do PC + ativacao + validacao contra o Worker.
// Este modulo NAO depende de Electron: recebe o diretorio userData em init().
// Persiste o token em <userData>/license.json (escrita atomica .tmp + rename).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const API_URL = 'https://deepseek.nogueira.workers.dev';
const REQUEST_TIMEOUT_MS = 8000;
const CHECKOUT_TIMEOUT_MS = 30000;   // o Worker faz 4 chamadas ao Asaas em sequencia (sandbox e lento)
const EXEC_TIMEOUT_MS = 8000;

const MIN_VALUE = 15;              // valor minimo da ajuda (R$)

let DATA_DIR = null;

function init(userDataDir) {
    DATA_DIR = userDataDir;
}

function licensePath() {
    if (!DATA_DIR) throw new Error('license.init() nao foi chamado');
    return path.join(DATA_DIR, 'license.json');
}

// ------------------------------------------------------------
// Execucao de comando (async, sem janela, com timeout). Retorna '' se falhar.
// ------------------------------------------------------------
function run(cmd, args) {
    return new Promise((resolve) => {
        try {
            execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
                if (err) return resolve('');
                resolve(String(stdout || ''));
            });
        } catch (e) {
            resolve('');
        }
    });
}

function clean(value) {
    return String(value || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

// ------------------------------------------------------------
// Componentes do fingerprint
// ------------------------------------------------------------
function getCpu() {
    try {
        const cpus = os.cpus();
        return cpus && cpus[0] ? String(cpus[0].model).trim() : '';
    } catch (e) {
        return '';
    }
}

async function getMachineId() {
    if (process.platform === 'win32') {
        const out = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
        const m = out.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
        return m ? m[1].trim() : '';
    }
    if (process.platform === 'linux') {
        for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
            try {
                const v = fs.readFileSync(f, 'utf8').trim();
                if (v) return v;
            } catch (e) { /* tenta o proximo */ }
        }
        return '';
    }
    if (process.platform === 'darwin') {
        const out = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
        const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
        return m ? m[1].trim() : '';
    }
    return '';
}

async function getDiskSerial() {
    if (process.platform === 'win32') {
        const out = await run('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            "(Get-CimInstance Win32_DiskDrive | Where-Object { $_.Index -eq 0 }).SerialNumber",
        ]);
        return out.trim();
    }
    if (process.platform === 'linux') {
        const out = await run('lsblk', ['-dno', 'SERIAL']);
        const first = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
        return first || '';
    }
    if (process.platform === 'darwin') {
        const out = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
        const m = out.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
        return m ? m[1].trim() : '';
    }
    return '';
}

// ------------------------------------------------------------
// Fingerprint: sha256(CPU | ID da maquina (OS) | serial do disco | plataforma-arch)
// ------------------------------------------------------------
async function getFingerprint() {
    const [machineId, disk] = await Promise.all([getMachineId(), getDiskSerial()]);
    const raw = [
        clean(getCpu()),
        clean(machineId),
        clean(disk),
        process.platform + '-' + process.arch,
    ].join('|');
    return crypto.createHash('sha256').update(raw).digest('hex');
}

// ------------------------------------------------------------
// Armazenamento do token
// ------------------------------------------------------------
function readStored() {
    try {
        const data = JSON.parse(fs.readFileSync(licensePath(), 'utf8'));
        if (data && typeof data.token === 'string' && data.token) return data;
    } catch (e) { /* sem licenca salva */ }
    return null;
}

function writeStored(token) {
    const file = licensePath();
    const tmp = file + '.tmp';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ token: token, saved_at: new Date().toISOString() }), 'utf8');
    fs.renameSync(tmp, file);
}

function clear() {
    try { fs.unlinkSync(licensePath()); } catch (e) { /* ignora */ }
}

// ------------------------------------------------------------
// HTTP. Retorna { status, body } ou { networkError: true }.
// ------------------------------------------------------------
async function request(method, route, payload, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || REQUEST_TIMEOUT_MS);
    try {
        const opts = { method: method, signal: controller.signal };
        if (payload !== undefined) {
            opts.headers = { 'Content-Type': 'application/json' };
            opts.body = JSON.stringify(payload);
        }
        const res = await fetch(API_URL + route, opts);
        let body = null;
        try { body = await res.json(); } catch (e) { body = null; }
        return { status: res.status, body: body };
    } catch (e) {
        return { networkError: true };
    } finally {
        clearTimeout(timer);
    }
}

const post = (route, payload, timeoutMs) => request('POST', route, payload, timeoutMs);

// ------------------------------------------------------------
// Teste gratis (7 dias, controlado pelo servidor; 1 por maquina).
// Retorna { ok: true } | { ok: false, offline?, trialUsed?, error }
// ------------------------------------------------------------
async function startTrial() {
    const fingerprint = await getFingerprint();
    const r = await post('/trial', { fingerprint: fingerprint });

    if (r.networkError) return { ok: false, offline: true, error: 'Sem conexão com o servidor de licenças' };
    if (r.status >= 500) return { ok: false, offline: true, error: 'Servidor de licenças indisponível' };
    if (r.status === 200 && r.body && r.body.token) {
        try {
            writeStored(r.body.token);
        } catch (e) {
            return { ok: false, error: 'Falha ao salvar a licença: ' + e.message };
        }
        return { ok: true };
    }
    if (r.body && r.body.trial_used) return { ok: false, trialUsed: true, error: r.body.error };
    return { ok: false, error: (r.body && r.body.error) || 'Não foi possível iniciar o teste gratuito' };
}

// ------------------------------------------------------------
// Ativacao: codigo -> token salvo.
// Retorna { ok: true } | { ok: false, offline?: true, error }
// ------------------------------------------------------------
async function activate(activationCode) {
    const code = String(activationCode || '').trim();
    if (!code) return { ok: false, error: 'Informe o código de ativação' };

    const fingerprint = await getFingerprint();
    const r = await post('/activate', { activation_code: code, fingerprint: fingerprint });

    if (r.networkError) return { ok: false, offline: true, error: 'Sem conexão com o servidor de licenças' };
    if (r.status >= 500) return { ok: false, offline: true, error: 'Servidor de licenças indisponível' };
    if (r.status === 200 && r.body && r.body.token) {
        try {
            writeStored(r.body.token);
        } catch (e) {
            return { ok: false, error: 'Falha ao salvar a licença: ' + e.message };
        }
        return { ok: true };
    }
    return { ok: false, error: (r.body && r.body.error) || 'Falha na ativação' };
}

// ------------------------------------------------------------
// Validacao: token salvo + fingerprint atual -> Worker.
// status: 'valid' (+ plan: 'trial'|'paid', expiresAt) | 'invalid' | 'offline' | 'no_license'
// 'invalid' apaga o token salvo (licenca bloqueada/outro dispositivo/teste vencido).
// ------------------------------------------------------------
async function validate() {
    const stored = readStored();
    if (!stored) return { status: 'no_license' };

    const fingerprint = await getFingerprint();
    const r = await post('/validate', { fingerprint: fingerprint, token: stored.token });

    if (r.networkError) return { status: 'offline' };
    if (r.status >= 500) return { status: 'offline' };
    if (r.status === 200 && r.body && r.body.valid === true) {
        return {
            status: 'valid',
            plan: r.body.plan === 'trial' ? 'trial' : 'paid',
            expiresAt: r.body.expires_at ? Number(r.body.expires_at) : 0,
        };
    }
    if (r.status === 403 || r.status === 400) {
        clear();
        return {
            status: 'invalid',
            trialExpired: !!(r.body && r.body.trial_expired),
            error: (r.body && r.body.error) || 'Licença inválida',
        };
    }
    return { status: 'offline' };
}

// ------------------------------------------------------------
// Checkout: gera a cobranca PIX (minimo R$ 15). O Asaas exige nome e CPF do pagador.
// Retorna { ok: true, cobranca_id, valor, pix_qrcode (data URI), pix_copia_cola }
//       | { ok: false, error }
// ------------------------------------------------------------
async function createCheckout(valor, payer) {
    const v = Number(valor);
    if (!isFinite(v) || v < MIN_VALUE) {
        return { ok: false, error: 'O valor mínimo é R$ ' + MIN_VALUE + ',00' };
    }
    payer = payer || {};
    const fingerprint = await getFingerprint();
    const r = await post('/checkout', {
        valor: v,
        fingerprint: fingerprint,
        nome: String(payer.nome || ''),
        cpf: String(payer.cpf || ''),
    }, CHECKOUT_TIMEOUT_MS);

    if (r.networkError) return { ok: false, error: 'O servidor de pagamentos não respondeu a tempo. Tente gerar o PIX de novo.' };
    if (r.status === 201 && r.body && r.body.cobranca_id) {
        return {
            ok: true,
            cobranca_id: r.body.cobranca_id,
            valor: r.body.valor,
            pix_qrcode: r.body.pix_qrcode,
            pix_copia_cola: r.body.pix_copia_cola,
        };
    }
    return { ok: false, error: (r.body && r.body.error) || 'Falha ao gerar o PIX' };
}

// ------------------------------------------------------------
// Status do pagamento (o modal consulta de tempos em tempos).
// status: 'PENDING' | 'RECEIVED' (com activation_code) | 'NOT_FOUND' | 'ERROR'
// ------------------------------------------------------------
async function checkoutStatus(cobrancaId) {
    const fingerprint = await getFingerprint();
    const r = await request('GET', '/checkout/' + encodeURIComponent(cobrancaId) + '/status?fingerprint=' + fingerprint);

    if (r.networkError || r.status >= 500) return { status: 'PENDING' };   // sem rede: segue tentando
    if (r.body && r.body.status) return r.body;
    return { status: 'ERROR', error: 'Não foi possível consultar o pagamento' };
}

module.exports = { init, getFingerprint, readStored, activate, startTrial, validate, clear, createCheckout, checkoutStatus, MIN_VALUE };