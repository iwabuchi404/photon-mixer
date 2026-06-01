/**
 * Block 3 ツール検証: 消しゴム+Undo, バケツ+Undo, スポイト
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
    pressure: 0.8, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  });
}
async function stroke(page, x1, y1, x2, y2, steps = 25) {
  await ptr(page, 'pointerdown', x1, y1);
  for (let i = 1; i <= steps; i++) {
    await ptr(page, 'pointermove', Math.round(x1 + (x2 - x1) * i / steps), Math.round(y1 + (y2 - y1) * i / steps));
    await new Promise(r => setTimeout(r, 10));
  }
  await ptr(page, 'pointerup', x2, y2);
  await new Promise(r => setTimeout(r, 200));
}
const setColor = (page, hex) => page.evaluate(h => {
  const p = document.getElementById('brush-color'); p.value = h; p.dispatchEvent(new Event('input'));
}, hex);
const setTool = (page, id) => page.evaluate(t => document.getElementById(t).click(), `tool-${id}`);
const key = (page, k, ctrl=false) => page.evaluate(([kk, c]) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: kk, ctrlKey: c, bubbles: true }));
}, [k, ctrl]);

let app;
try {
  app = await electron.launch({ executablePath: electronBin, args: [APP_DIR], timeout: 30_000, env: { ...process.env } });
  await new Promise(r => setTimeout(r, 4000));
  let page = app.windows().find(w => !w.url().startsWith('devtools://')) || await app.firstWindow();
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });

  const { cw, ch } = await page.evaluate(() => ({ cw: document.getElementById('canvas').width, ch: document.getElementById('canvas').height }));
  const cx = Math.round(cw/2), cy = Math.round(ch/2);

  // 1) 赤線 → 青線 を引く
  await setColor(page, '#ff0000'); await stroke(page, cx-250, cy-60, cx+250, cy-60);
  await setColor(page, '#3366ff'); await stroke(page, cx-250, cy, cx+250, cy);
  await page.screenshot({ path: path.join(SHOT_DIR, 't1-two-lines.png') });

  // 2) 消しゴムで青線の中央を消す
  await setTool(page, 'eraser');
  await stroke(page, cx-40, cy, cx+40, cy);
  await page.screenshot({ path: path.join(SHOT_DIR, 't2-erased.png') });

  // 3) Undo（消しゴムが取り消され、青線が戻るはず。赤として化けないこと）
  await key(page, 'z', true);
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(SHOT_DIR, 't3-undo-erase.png') });

  // 4) Redo（消しゴムが再適用）
  await key(page, 'y', true);
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(SHOT_DIR, 't4-redo-erase.png') });

  // 5) バケツ塗り（緑）→ Undo で消えること
  await setTool(page, 'brush');
  await setColor(page, '#00cc00');
  await setTool(page, 'bucket');
  await ptr(page, 'pointerdown', cx-200, cy+120); // 空白領域を塗る
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(SHOT_DIR, 't5-bucket.png') });
  await key(page, 'z', true);
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(SHOT_DIR, 't6-undo-bucket.png') });

  console.log('警告/エラー:', logs.length ? logs : 'なし');
  const fps = await page.evaluate(() => document.getElementById('fps').textContent);
  console.log('FPS:', fps);
} finally {
  if (app) { await new Promise(r => setTimeout(r, 300)); await app.close().catch(() => {}); }
}
