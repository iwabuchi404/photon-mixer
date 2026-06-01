/**
 * progressive 1本を拡大して混色グラデーションの質を診断
 */
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(APP_DIR, 'screenshots');
const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron.exe');

async function ptr(page, type, x, y) {
  await page.dispatchEvent('#canvas', type, {
    pointerType: 'mouse', clientX: x, clientY: y,
    pressure: 0.6, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  });
}

let app;
try {
  app = await electron.launch({ executablePath: electronBin, args: [APP_DIR], timeout: 30_000, env: { ...process.env } });
  await new Promise(r => setTimeout(r, 4000));
  let page = app.windows().find(w => !w.url().startsWith('devtools://')) || await app.firstWindow();

  const { cw, ch } = await page.evaluate(() => ({ cw: document.getElementById('canvas').width, ch: document.getElementById('canvas').height }));
  const cx = Math.round(cw / 2), cy = Math.round(ch / 2);

  // 太い赤の縦帯を描く（下地）
  await page.evaluate(() => {
    document.getElementById('brush-size').value = '60'; document.getElementById('brush-size').dispatchEvent(new Event('input'));
    document.getElementById('brush-color').value = '#ff0000'; document.getElementById('brush-color').dispatchEvent(new Event('input'));
  });
  await ptr(page, 'pointerdown', cx, cy - 120);
  for (let i = 1; i <= 30; i++) { await ptr(page, 'pointermove', cx, cy - 120 + i * 8); await new Promise(r => setTimeout(r, 8)); }
  await ptr(page, 'pointerup', cx, cy + 120);
  await new Promise(r => setTimeout(r, 400));

  // 白・引きずり・wet80 で赤帯をゆっくり横切る
  await page.evaluate(() => {
    document.getElementById('brush-size').value = '24'; document.getElementById('brush-size').dispatchEvent(new Event('input'));
    document.getElementById('brush-color').value = '#ffffff'; document.getElementById('brush-color').dispatchEvent(new Event('input'));
    document.getElementById('mix-mode').value = 'progressive'; document.getElementById('mix-mode').dispatchEvent(new Event('change'));
    document.getElementById('brush-wet').value = '80'; document.getElementById('brush-wet').dispatchEvent(new Event('input'));
    document.getElementById('brush-alpha').value = '100'; document.getElementById('brush-alpha').dispatchEvent(new Event('input'));
  });

  // ゆっくり（混色解像度を見るため）と速く、2本引く
  // 遅い: cy-40
  await ptr(page, 'pointerdown', cx - 220, cy - 40);
  await new Promise(r => setTimeout(r, 1200)); // snapshot 待ち
  for (let i = 1; i <= 60; i++) { await ptr(page, 'pointermove', Math.round(cx - 220 + 440 * i / 60), cy - 40); await new Promise(r => setTimeout(r, 25)); }
  await ptr(page, 'pointerup', cx + 220, cy - 40);
  await new Promise(r => setTimeout(r, 300));

  // 速い: cy+40
  await ptr(page, 'pointerdown', cx - 220, cy + 40);
  await new Promise(r => setTimeout(r, 1200));
  for (let i = 1; i <= 15; i++) { await ptr(page, 'pointermove', Math.round(cx - 220 + 440 * i / 15), cy + 40); await new Promise(r => setTimeout(r, 16)); }
  await ptr(page, 'pointerup', cx + 220, cy + 40);
  await new Promise(r => setTimeout(r, 400));

  // 全体 + 拡大クロップ
  await page.screenshot({ path: path.join(SHOT_DIR, 'zoom-full.png') });
  await page.screenshot({
    path: path.join(SHOT_DIR, 'zoom-crop.png'),
    clip: { x: cx - 240, y: cy - 80, width: 480, height: 160 },
  });
  console.log('遅い線=上, 速い線=下');

} finally {
  if (app) { await new Promise(r => setTimeout(r, 300)); await app.close().catch(() => {}); }
}
