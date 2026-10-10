// esbuild で core/main.gas.ts を単一の GAS 用 Code.js にバンドルする
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

const footer = `
function doPost(e) { return CH.doPost(e); }
function doGet(e) { return CH.doGet(e); }
function dispatchNotifications() { return CH.dispatchNotifications(); }
function dailyBackup() { return CH.dailyBackup(); }
function restoreBackup(targetProjectId, fullFileId, incrementalFileIdsCsv, confirm) { return CH.restoreBackup(targetProjectId, fullFileId, incrementalFileIdsCsv, confirm); }
function backupNow(kind) { return CH.backupNow(kind); }
function setupTriggers() { return CH.setupTriggers(); }
`;

await build({
  entryPoints: ['core/main.gas.ts'],
  outfile: 'dist/Code.js',
  bundle: true,
  format: 'iife',
  globalName: 'CH',
  target: 'es2020',
  platform: 'neutral',
  minify: false,
  legalComments: 'none',
  footer: { js: footer },
  logLevel: 'info',
});

cpSync('appsscript.json', 'dist/appsscript.json');
console.log('built dist/Code.js');
