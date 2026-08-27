const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  outDir: '../../dist/electron',
  packagerConfig: {
    asar: true,
    name: 'piDeck',
    // The Electron main bundle contains the Supervisor and its dependencies.
    // Keep pnpm's workspace tree out of the archive entirely.
    prune: false,
    ignore: /(?:^|[\\/])(?:node_modules|out|\.turbo)(?:[\\/]|$)/,
    ...(process.platform === 'darwin' && process.env.APPLE_ID
      ? {
          osxSign: {},
          osxNotarize: {
            appleId: process.env.APPLE_ID,
            appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
            teamId: process.env.APPLE_TEAM_ID,
          },
        }
      : {}),
  },
  makers: [
    { name: '@electron-forge/maker-dmg', platforms: ['darwin'] },
    { name: '@electron-forge/maker-zip', platforms: ['win32', 'linux'] },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-fuses',
      config: {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
      },
    },
  ],
};
