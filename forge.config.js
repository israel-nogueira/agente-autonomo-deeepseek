const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true,
    // Sem extensão! O Forge resolve .ico/.icns/.png por plataforma automaticamente.
    icon: 'renderer/icons/app/favicon',
    // Boa prática: nome final do executável
    name: 'OpenDeepSeek',
    // Remove arquivos desnecessários do bundle final
    ignore: [
      /^\/\.git/,
      /^\/\.vscode/,
      /^\/out/,
      /^\/README\.md$/,
      /^\/forge\.config\.js$/,
      /^\/\.github/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        // Aqui a extensão é OBRIGATÓRIA
        setupIcon: 'renderer/icons/app/favicon.ico',
        // Nome que aparece no menu Iniciar / Adicionar-Remover Programas
        name: 'OpenDeepSeek',
        // Autor (aparece no instalador)
        authors: 'Israel Nogueira',
        // Descrição curta mostrada no instalador
        description: 'Agente de código que usa o DeepSeek web',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          icon: 'renderer/icons/app/favicon.png',
          maintainer: 'Israel Nogueira',
          homepage: 'https://github.com/israel-nogueira/agente-autonomo-deeepseek',
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: {
          icon: 'renderer/icons/app/favicon.png',
          homepage: 'https://github.com/israel-nogueira/agente-autonomo-deeepseek',
        },
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};