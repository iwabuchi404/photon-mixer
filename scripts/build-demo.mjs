// Webデモ配布物の組み立て（依存ゼロ）
//   demo/index.html            (そのまま。相対パスのまま動く)
//   demo/dist/                 (ビルド成果物＋シェーダー)
//   demo/node_modules/{fflate,lit,lit-html,lit-element,@lit}  (importmap 分のみ)
// 静的ホスティングに demo/ をそのまま置けば動く。URL は ?demo=1 を付ける。
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const out = join(root, 'demo');

const VENDOR_PKGS = ['fflate', 'lit', 'lit-html', 'lit-element', '@lit'];

if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// index.html + dist
cpSync(join(root, 'index.html'), join(out, 'index.html'));
cpSync(join(root, 'dist'), join(out, 'dist'), { recursive: true, force: true });
// importmap の vendor のみ
for (const pkg of VENDOR_PKGS) {
  const src = join(root, 'node_modules', ...pkg.split('/'));
  if (!existsSync(src)) throw new Error(`missing vendor package: ${pkg}`);
  cpSync(src, join(out, 'node_modules', ...pkg.split('/')), { recursive: true, force: true });
}

const du = (dir) => {
  let sum = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sum += du(p);
    else sum += statSync(p).size;
  }
  return sum;
};

console.log(`[build-demo] demo/ assembled: ${(du(out) / 1024 / 1024).toFixed(1)} MiB`);
console.log('[build-demo] serve with: npm run demo:serve  (open http://localhost:8080/?demo=1)');
