// scripts/compile-worker.js
// Recebe uma lista de arquivos .js via argv (JSON) e compila cada um para .jsc.
// Precisa rodar com o binário do Electron + ELECTRON_RUN_AS_NODE=1 (ver protect.js),
// pra o bytecode gerado ser compatível com a versão de V8 do Electron empacotado.

const bytenode = require('bytenode');

async function main() {
  const files = JSON.parse(process.argv[2]);

  for (const filePath of files) {
    const jscPath = filePath.replace(/\.js$/, '.jsc');
    await bytenode.compileFile({
      filename: filePath,
      output: jscPath,
    });
    console.log('[compile-worker] Compilado:', filePath, '->', jscPath);
  }
}

main().catch(err => {
  console.error('[compile-worker] Erro:', err);
  process.exit(1);
});