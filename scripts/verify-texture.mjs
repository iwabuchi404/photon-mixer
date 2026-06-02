/**
 * Block 4 検証: テクスチャブラシ・プリセット保存/読み込み
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
  await page.dispatchEvent('#canvas', type, { pointerType: 'mouse', clientX: x, clientY: y, pressure: 0.9, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
}
async function stroke(page, x1, y1, x2, y2, n = 30) {
  await ptr(page, 'pointerdown', x1, y1);
  for (let i = 1; i <= n; i++) { await ptr(page, 'pointermove', Math.round(x1+(x2-x1)*i/n), Math.round(y1+(y2-y1)*i/n)); await new Promise(r=>setTimeout(r,8)); }
  await ptr(page, 'pointerup', x2, y2);
  await new Promise(r=>setTimeout(r,200));
}

let app;
try {
  app = await electron.launch({ executablePath: electronBin, args: [APP_DIR], timeout: 30000, env: { ...process.env } });
  await new Promise(r => setTimeout(r, 4000));
  let page = app.windows().find(w => !w.url().startsWith('devtools://')) || await app.firstWindow();
  const logs = [];
  page.on('console', m => { if (m.type()==='error'||m.type()==='warning') logs.push(`[${m.type()}] ${m.text()}`); });

  // キャンバス作成
  await page.evaluate(() => {
    document.getElementById('canvas-w').value = '800';
    document.getElementById('canvas-h').value = '600';
    document.getElementById('create-canvas-btn').click();
  });
  await new Promise(r => setTimeout(r, 500));

  const sz = await page.evaluate(() => ({ cw: document.getElementById('canvas').width, ch: document.getElementById('canvas').height }));
  const scx = Math.round(sz.cw/2), scy = Math.round(sz.ch/2);

  // ① 通常の円形ブラシで線
  await page.evaluate(() => { const p=document.getElementById('brush-color'); p.value='#ffffff'; p.dispatchEvent(new Event('input')); });
  await stroke(page, scx-200, scy-80, scx+200, scy-80);

  // ② テクスチャPNGをページ内生成→ DataTransfer 経由でfile input にセットして change 発火
  await page.evaluate(async () => {
    // 市松模様（アルファ付き）のテクスチャを生成
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(64, 64);
    for (let y=0;y<64;y++) for (let x=0;x<64;x++){
      const i=(y*64+x)*4;
      const on = ((x>>3)+(y>>3))%2===0;
      img.data[i]=255; img.data[i+1]=255; img.data[i+2]=255;
      img.data[i+3]= on ? 255 : 0; // アルファで市松
    }
    ctx.putImageData(img,0,0);
    const blob = await new Promise(res => c.toBlob(res,'image/png'));
    const file = new File([blob], 'tex.png', { type:'image/png' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.getElementById('texture-file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 600));

  // テクスチャスケール上げる
  await page.evaluate(() => { const s=document.getElementById('texture-scale'); s.value='20'; s.dispatchEvent(new Event('input')); });

  // ③ テクスチャブラシで線
  await page.evaluate(() => { const p=document.getElementById('brush-color'); p.value='#ff6600'; p.dispatchEvent(new Event('input')); });
  await stroke(page, scx-200, scy+40, scx+200, scy+40);
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(SHOT_DIR, 'tex-1-stroke.png') });

  // ④ テクスチャクリア → 円形に戻る
  await page.evaluate(() => document.getElementById('clear-texture-btn')?.click());
  await page.evaluate(() => { const p=document.getElementById('brush-color'); p.value='#00ccff'; p.dispatchEvent(new Event('input')); });
  await stroke(page, scx-200, scy+120, scx+200, scy+120);
  await page.screenshot({ path: path.join(SHOT_DIR, 'tex-2-cleared.png') });

  console.log('FPS:', await page.evaluate(() => document.getElementById('fps').textContent));
  console.log('警告/エラー:', logs.length ? logs : 'なし');
} finally {
  if (app) { await new Promise(r=>setTimeout(r,300)); await app.close().catch(()=>{}); }
}
