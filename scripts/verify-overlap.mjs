/**
 * progressive モードで半透明ストロークを重ねて濃淡の崩れを検証する
 */

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(APP_DIR, 'screenshots');

const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron.exe');

async function ptr(page, type, x, y) {
  await page.dispatchEvent('#canvas', type, {
    pointerType: 'mouse', clientX: x, clientY: y,
    pressure: 0.5, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  });
}

async function stroke(page, x1, y1, x2, y2, steps = 40) {
  await ptr(page, 'pointerdown', x1, y1);
  await new Promise(r => setTimeout(r, 50));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await ptr(page, 'pointermove', Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t));
    await new Promise(r => setTimeout(r, 12));
  }
  await ptr(page, 'pointerup', x2, y2);
  await new Promise(r => setTimeout(r, 200));
}

let app;
try {
  app = await electron.launch({
    executablePath: electronBin, args: [APP_DIR], timeout: 30_000, env: { ...process.env },
  });
  await new Promise(r => setTimeout(r, 4000));
  let page = app.windows().find(w => !w.url().startsWith('devtools://'));
  if (!page) page = await app.firstWindow();

  const { cw, ch } = await page.evaluate(() => ({
    cw: document.getElementById('canvas').width, ch: document.getElementById('canvas').height,
  }));
  const cx = Math.round(cw / 2), cy = Math.round(ch / 2);

  // 半透明 + progressive モードに設定
  await page.evaluate(() => {
    document.getElementById('brush-alpha').value = '50';
    document.getElementById('brush-alpha').dispatchEvent(new Event('input'));
    document.getElementById('mix-mode').value = 'progressive';
    document.getElementById('mix-mode').dispatchEvent(new Event('change'));
    document.getElementById('brush-wet').value = '50';
    document.getElementById('brush-wet').dispatchEvent(new Event('input'));
    document.getElementById('brush-size').value = '40';
    document.getElementById('brush-size').dispatchEvent(new Event('input'));
  });
  await new Promise(r => setTimeout(r, 100));

  // 青で平行な半透明ストロークを数本、少しずつ重ねながら引く
  const colors = ['#3030ff', '#ff3030', '#30ff30'];
  let ci = 0;
  for (let i = 0; i < 5; i++) {
    await page.evaluate((hex) => {
      document.getElementById('brush-color').value = hex;
      document.getElementById('brush-color').dispatchEvent(new Event('input'));
    }, colors[ci % colors.length]);
    ci++;
    const y = cy - 80 + i * 35;
    await stroke(page, cx - 250, y, cx + 250, y + 20, 45);
  }

  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(SHOT_DIR, 'overlap-test.png') });

  const perf = await page.evaluate(() => ({
    fps: document.getElementById('fps').textContent,
  }));
  console.log('FPS:', perf.fps);

  const errors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  await new Promise(r => setTimeout(r, 300));
  console.log('警告/エラー:', errors.length ? errors : 'なし');

} finally {
  if (app) { await new Promise(r => setTimeout(r, 300)); await app.close().catch(() => {}); }
}
