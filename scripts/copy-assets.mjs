// クロスプラットフォーム版アセットコピー
// 従来の PowerShell 版 (Copy-Item) の代わり。Windows / macOS / Linux で動作。
// 実行内容:
//   shaders/            -> dist/shaders/
//   electron/preload.cjs -> dist/electron/preload.cjs
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const distElectron = join(root, 'dist', 'electron');
mkdirSync(distElectron, { recursive: true });

cpSync(join(root, 'shaders'), join(root, 'dist', 'shaders'), {
  recursive: true,
  force: true,
});
cpSync(
  join(root, 'electron', 'preload.cjs'),
  join(distElectron, 'preload.cjs'),
  { force: true },
);

console.log('[copy-assets] shaders/ and electron/preload.cjs -> dist/');
