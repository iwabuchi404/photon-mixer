/**
 * Step 2 検証: モーダル→キャンバス作成→描画→回転→PNG書き出し
 */
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(APP_DIR, 'screenshots');
const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron.exe');

async function ptr(page, type, x, y) {
  await page.dispatchEvent('#canvas', type, { pointerType: 'mouse', clientX: x, clientY: y, pressure: 0.8, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
}
async function stroke(page, x1, y1, x2, y2, n = 25) {
  await ptr(page, 'pointerdown', x1, y1);
  for (let i = 1; i <= n; i++) { await ptr(page, 'pointermove', Math.round(x1+(x2-x1)*i/n), Math.round(y1+(y2-y1)*i/n)); await new Promise(r=>setTimeout(r,8)); }
  await ptr(page, 'pointerup', x2, y2);
  await new Promise(r=>setTimeout(r,150));
}

let app;
try {
  app = await electron.launch({ executablePath: electronBin, args: [APP_DIR], timeout: 30000, env: { ...process.env } });
  await new Promise(r => setTimeout(r, 4000));
  let page = app.windows().find(w => !w.url().startsWith('devtools://')) || await app.firstWindow();
  const logs = [];
  page.on('console', m => { if (m.type()==='error'||m.type()==='warning') logs.push(`[${m.type()}] ${m.text()}`); });

  // モーダルでキャンバス作成（デフォルト 2000x2000 を 800x600 に）
  await page.evaluate(() => {
    document.getElementById('canvas-w').value = '800';
    document.getElementById('canvas-h').value = '600';
    document.getElementById('create-canvas-btn').click();
  });
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(SHOT_DIR, 's2-1-created.png') });

  const sz = await page.evaluate(() => ({ cw: document.getElementById('canvas').width, ch: document.getElementById('canvas').height }));
  const scx = Math.round(sz.cw/2), scy = Math.round(sz.ch/2);

  // 赤線・青線（スクリーン中央付近に）
  await page.evaluate(() => { const p=document.getElementById('brush-color'); p.value='#ff0000'; p.dispatchEvent(new Event('input')); });
  await stroke(page, scx-150, scy-40, scx+150, scy-40);
  await page.evaluate(() => { const p=document.getElementById('brush-color'); p.value='#3366ff'; p.dispatchEvent(new Event('input')); });
  await stroke(page, scx-150, scy+40, scx+150, scy+40);
  await page.screenshot({ path: path.join(SHOT_DIR, 's2-2-drawn.png') });

  // サイズ数値入力テスト
  const sizeSync = await page.evaluate(() => {
    const num = document.getElementById('brush-size-num');
    num.value = '60'; num.dispatchEvent(new Event('input'));
    return { slider: document.getElementById('brush-size').value, num: num.value };
  });
  console.log('サイズ同期:', JSON.stringify(sizeSync));

  // 回転（Alt+wheel を模擬：viewport.rotate を直接叩けないので wheel イベント）
  await page.evaluate(([cx, cy]) => {
    const c = document.getElementById('canvas');
    for (let i=0;i<8;i++) c.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, altKey: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
  }, [scx, scy]);
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(SHOT_DIR, 's2-3-rotated.png') });

  // PNG 書き出し: exportToPNG を直接呼べないのでボタン経由は download。
  // 代わりにページ内で committed を読み出す手段がないため、ボタンクリックでエラーが出ないことだけ確認
  await page.evaluate(() => document.getElementById('export-png-btn').click());
  await new Promise(r => setTimeout(r, 600));

  // 回転リセット
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true })));
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(SHOT_DIR, 's2-4-reset.png') });

  console.log('FPS:', await page.evaluate(() => document.getElementById('fps').textContent));
  console.log('警告/エラー:', logs.length ? logs : 'なし');
} finally {
  if (app) { await new Promise(r=>setTimeout(r,300)); await app.close().catch(()=>{}); }
}
