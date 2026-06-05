/**
 * Block 6.5 Phase D 検証: 選択範囲（投げ縄・自動選択・反転）+ マスク連携の移動/変形
 *
 * 確認ポイント:
 *  - 自動選択(magic wand): 連結同色領域が選択され、選択外には描画されない
 *  - 投げ縄(lasso): 任意多角形で選択でき、マーチングアントが表示される
 *  - 反転(invert): 選択範囲が反転する
 *  - 移動(move): 非矩形選択でも選択ピクセルのみが動く
 *  - 変形(transform): 非矩形選択でも選択ピクセルのみが変形する
 *
 * スクリーンショットは screenshots/ に保存される（目視確認用）。
 */
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(APP_DIR, 'screenshots');
const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron.exe');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function ptr(page, type, x, y) {
  await page.dispatchEvent('#canvas', type, {
    pointerType: 'mouse', clientX: x, clientY: y,
    pressure: 0.8, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  });
}
async function stroke(page, pts, steps = 6) {
  await ptr(page, 'pointerdown', pts[0][0], pts[0][1]);
  for (let s = 1; s < pts.length; s++) {
    const [x0, y0] = pts[s - 1], [x1, y1] = pts[s];
    for (let i = 1; i <= steps; i++) {
      await ptr(page, 'pointermove', Math.round(x0 + (x1 - x0) * i / steps), Math.round(y0 + (y1 - y0) * i / steps));
      await sleep(6);
    }
  }
  await ptr(page, 'pointerup', pts[pts.length - 1][0], pts[pts.length - 1][1]);
  await sleep(150);
}
const setColor = (page, hex) => page.evaluate(h => {
  const p = document.getElementById('brush-color'); p.value = h; p.dispatchEvent(new Event('input'));
}, hex);
const click = (page, id) => page.evaluate(t => document.getElementById(t)?.click(), id);
const setTool = (page, id) => click(page, `tool-${id}`);
const setSlider = (page, id, val) => page.evaluate(([i, v]) => {
  const s = document.getElementById(i); s.value = String(v); s.dispatchEvent(new Event('input'));
}, [id, val]);
const setSize = (page, v) => setSlider(page, 'brush-size', v);

let app;
try {
  app = await electron.launch({ executablePath: electronBin, args: [APP_DIR], timeout: 30_000, env: { ...process.env } });
  await sleep(4000);
  const page = app.windows().find(w => !w.url().startsWith('devtools://')) || await app.firstWindow();
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });

  const { cw, ch } = await page.evaluate(() => ({ cw: document.getElementById('canvas').width, ch: document.getElementById('canvas').height }));
  const cx = Math.round(cw / 2), cy = Math.round(ch / 2);

  // 0) 大きめの赤い塊を描く（自動選択の対象）
  await setTool(page, 'brush');
  await setSize(page, 90);
  await setColor(page, '#ee2222');
  await stroke(page, [[cx - 160, cy], [cx + 160, cy]]);
  await page.screenshot({ path: path.join(SHOT_DIR, 'd0-red-blob.png') });

  // 1) 自動選択: 許容値を上げて赤い塊をクリック → 連結領域が選択される
  await setTool(page, 'select');
  await click(page, 'select-mode-wand');
  await setSlider(page, 'bucket-tolerance', 40);
  await ptr(page, 'pointerdown', cx, cy);
  await ptr(page, 'pointerup', cx, cy);
  await sleep(400);
  await page.screenshot({ path: path.join(SHOT_DIR, 'd1-wand-selection.png') });

  // 2) 選択中に青で大きく描く → 選択（赤塊）内のみ着色されるはず
  await setTool(page, 'brush');
  await setColor(page, '#2244ee');
  await setSize(page, 40);
  await stroke(page, [[cx - 300, cy - 120], [cx + 300, cy + 120]]);
  await page.screenshot({ path: path.join(SHOT_DIR, 'd2-draw-inside-wand.png') });

  // 3) 選択解除してリセット
  await setTool(page, 'select');
  await click(page, 'select-clear');
  await sleep(100);
  await click(page, 'clear-btn'); // アクティブレイヤークリア
  await sleep(100);

  // 4) 投げ縄選択（三角形）
  await setTool(page, 'brush'); await setSize(page, 90); await setColor(page, '#22aa44');
  await stroke(page, [[cx - 160, cy], [cx + 160, cy]]);
  await setTool(page, 'select');
  await click(page, 'select-mode-lasso');
  await stroke(page, [[cx - 180, cy + 80], [cx, cy - 120], [cx + 180, cy + 80], [cx - 180, cy + 80]], 4);
  await sleep(300);
  await page.screenshot({ path: path.join(SHOT_DIR, 'd3-lasso-selection.png') });

  // 5) 反転 → 反転枠が出る
  await click(page, 'select-invert');
  await sleep(300);
  await page.screenshot({ path: path.join(SHOT_DIR, 'd4-invert.png') });

  // 6) 移動: 矩形選択 → 移動ツールでドラッグ（選択ピクセルのみ動く）
  await click(page, 'select-mode-rect');
  await stroke(page, [[cx - 120, cy - 80], [cx + 120, cy + 80]], 2); // 矩形選択
  await sleep(200);
  await setTool(page, 'move');
  await stroke(page, [[cx, cy], [cx + 180, cy - 60]], 6);
  await sleep(200);
  await page.screenshot({ path: path.join(SHOT_DIR, 'd5-move.png') });

  // 7) 変形: 矩形選択 → 変形ツール → 右上コーナーを外側へドラッグ（拡大）
  await setTool(page, 'select');
  await stroke(page, [[cx - 120, cy - 100], [cx + 120, cy + 60]], 2);
  await sleep(200);
  await setTool(page, 'transform');
  await sleep(400);
  // 右上コーナー付近をさらに右上へドラッグ
  await stroke(page, [[cx + 120, cy - 100], [cx + 220, cy - 180]], 6);
  await sleep(200);
  await page.screenshot({ path: path.join(SHOT_DIR, 'd6-transform.png') });
  // 確定
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await sleep(200);
  await page.screenshot({ path: path.join(SHOT_DIR, 'd7-transform-commit.png') });

  console.log('警告/エラー:', logs.length ? logs : 'なし');
  const fps = await page.evaluate(() => document.getElementById('fps')?.textContent);
  console.log('FPS:', fps);
  console.log('スクリーンショット:', SHOT_DIR);
} finally {
  if (app) { await sleep(300); await app.close().catch(() => {}); }
}
