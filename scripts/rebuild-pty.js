/**
 * Rebuilds @homebridge/node-pty-prebuilt-multiarch for the installed Electron version.
 * Run this after: npm install --ignore-scripts && node scripts/patch-node-pty.js
 */

const path = require('path');

// Read installed electron version
let electronVersion;
try {
  const electronPkg = require(path.resolve(__dirname, '..', 'node_modules', 'electron', 'package.json'));
  electronVersion = electronPkg.version;
} catch (e) {
  console.error('Could not find electron package.json:', e.message);
  process.exit(1);
}

console.log(`[rebuild-pty] Rebuilding for Electron ${electronVersion}...`);

const rebuild = require(path.resolve(__dirname, '..', 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js'));
// The CLI module exports nothing useful directly — invoke via child_process instead

const { spawnSync } = require('child_process');
const result = spawnSync(
  process.execPath,
  [
    path.resolve(__dirname, '..', 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js'),
    '--version', electronVersion,
    '--module-dir', path.resolve(__dirname, '..', 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch'),
    '--force',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      MSYS_NO_PATHCONV: '1',
      MSYS2_ARG_CONV_EXCL: '*',
    },
  }
);

process.exit(result.status ?? 0);
