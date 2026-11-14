// scripts/protect.js
// Roda DEPOIS que o Forge copia os arquivos pra pasta de build (hook afterCopy).
// Compila agent/*.js e main.js para bytecode (.jsc) via bytenode, usando o
// binário do próprio Electron (V8 compatível). Ofusca preload.js.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const JavaScriptObfuscator = require('javascript-obfuscator');

// Caminho do binário do Electron do próprio projeto (node_modules/electron).
// Rodar o compile-worker.js através dele (com ELECTRON_RUN_AS_NODE=1) garante
// que o bytecode gerado seja compatível com a V8 do Electron empacotado.
const electronBinary = require('electron');

/**
 * Nova API do @electron/packager: um único objeto como argumento,
 * sem callback — a função deve retornar/ser uma Promise.
 * @param {{ buildPath: string, electronVersion: string, platform: string, arch: string }} params
 */
module.exports = async function protect({ buildPath, electronVersion, platform, arch }) {
    console.log('[protect] Iniciando proteção do fonte em:', buildPath);

    const filesToCompile = [path.join(buildPath, 'main.js')];

    const agentDir = path.join(buildPath, 'agent');
    if (fs.existsSync(agentDir)) {
        const agentFiles = fs.readdirSync(agentDir).filter(f => f.endsWith('.js'));
        for (const file of agentFiles) {
            filesToCompile.push(path.join(agentDir, file));
        }
    } else {
        console.warn('[protect] Pasta agent/ não encontrada em', buildPath);
    }

    const existingFiles = filesToCompile.filter(f => {
        if (!fs.existsSync(f)) {
            console.warn('[protect] Arquivo não encontrado, pulando:', f);
            return false;
        }
        return true;
    });

    if (existingFiles.length > 0) {
        compileViaElectron(existingFiles);
        for (const filePath of existingFiles) {
            replaceWithLoader(filePath);
        }
    }

    // Ofuscar preload.js (sem bytenode, só obfuscation)
    const preloadPath = path.join(buildPath, 'preload.js');
    if (fs.existsSync(preloadPath)) {
        obfuscateFile(preloadPath);
    } else {
        console.warn('[protect] preload.js não encontrado em', buildPath);
    }

    console.log('[protect] Proteção concluída.');
};

function compileViaElectron(files) {
    const workerPath = path.join(__dirname, 'compile-worker.js');

    execFileSync(electronBinary, [workerPath, JSON.stringify(files)], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'inherit',
    });
}

function replaceWithLoader(filePath) {
    const jscPath = filePath.replace(/\.js$/, '.jsc');
    const loaderContent = `require('bytenode');\nmodule.exports = require('./${path.basename(jscPath)}');\n`;
    fs.writeFileSync(filePath, loaderContent, 'utf8');
    console.log('[protect] Loader gravado:', path.basename(filePath), '->', path.basename(jscPath));
}

function obfuscateFile(filePath) {
    const code = fs.readFileSync(filePath, 'utf8');

    const result = JavaScriptObfuscator.obfuscate(code, {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.75,
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.4,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 0.75,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,
        selfDefending: true,
    });

    fs.writeFileSync(filePath, result.getObfuscatedCode(), 'utf8');
    console.log('[protect] Ofuscado:', path.basename(filePath));
}