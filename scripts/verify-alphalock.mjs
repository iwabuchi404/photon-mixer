/**
 * Block 6.5 E-3 検証: アルファロック（透明部分保護）
 */
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(APP_DIR, 'screenshots');
const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron.exe');

async function ptr(page, type, x, y) {
  await page.dispatchEvent('#canvas', type, { pointerType:'mouse', clientX:x, clientY:y, pressure:0.9, button:0, buttons: type==='pointerup'?0:1 });
}
async function stroke(page, x1, y1, x2, y2, n=30) {
  await ptr(page,'pointerdown',x1,y1);
  for (let i=1;i<=n;i++){ await ptr(page,'pointermove',Math.round(x1+(x2-x1)*i/n),Math.round(y1+(y2-y1)*i/n)); await new Promise(r=>setTimeout(r,8)); }
  await ptr(page,'pointerup',x2,y2);
  await new Promise(r=>setTimeout(r,150));
}
const setColor=(page,hex)=>page.evaluate(h=>{const p=document.getElementById('brush-color');p.value=h;p.dispatchEvent(new Event('input'));},hex);

let app;
try {
  app = await electron.launch({ executablePath: electronBin, args:[APP_DIR], timeout:30000, env:{...process.env} });
  await new Promise(r=>setTimeout(r,4000));
  let page = app.windows().find(w=>!w.url().startsWith('devtools://')) || await app.firstWindow();
  page.on('dialog', d=>d.dismiss().catch(()=>{}));
  const logs=[]; page.on('console',m=>{ if(m.type()==='error'||m.type()==='warning') logs.push(`[${m.type()}] ${m.text()}`); });

  await page.evaluate(()=>{ document.getElementById('canvas-w').value='800'; document.getElementById('canvas-h').value='600'; document.getElementById('create-canvas-btn').click(); });
  await new Promise(r=>setTimeout(r,500));
  const sz = await page.evaluate(()=>({cw:document.getElementById('canvas').width, ch:document.getElementById('canvas').height}));
  const cx=Math.round(sz.cw/2), cy=Math.round(sz.ch/2);
  await page.evaluate(()=>document.getElementById('bg-white').click());

  // 赤い円形ベタ（太いストロークで塊）を描く
  await page.evaluate(()=>{ const s=document.getElementById('brush-size'); s.value='80'; s.dispatchEvent(new Event('input')); });
  await setColor(page,'#dd2222');
  await stroke(page, cx-100, cy, cx+100, cy, 30);
  await page.screenshot({ path: path.join(SHOT_DIR,'alphalock-1-base.png') });

  // アルファロックON（レイヤーのロックトグル）
  await page.evaluate(()=>{ const locks=[...document.querySelectorAll('#layer-list span')].filter(s=>s.textContent==='🔓'); if(locks[0]) locks[0].click(); });
  await new Promise(r=>setTimeout(r,100));
  const locked = await page.evaluate(()=>!![...document.querySelectorAll('#layer-list span')].find(s=>s.textContent==='🔒'));
  console.log('アルファロックON:', locked);

  // 青で大きくはみ出して塗る → 赤の範囲内だけ青になり、外（白背景）には描かれないはず
  await page.evaluate(()=>{ const s=document.getElementById('brush-size'); s.value='40'; s.dispatchEvent(new Event('input')); });
  await setColor(page,'#2222dd');
  await stroke(page, cx-200, cy-60, cx+200, cy+60, 40);
  await page.screenshot({ path: path.join(SHOT_DIR,'alphalock-2-locked-paint.png') });

  // Undo で青を取り消し → 赤だけ残る（rebakeでもロック再現）
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true})));
  await new Promise(r=>setTimeout(r,200));
  await page.screenshot({ path: path.join(SHOT_DIR,'alphalock-3-undo.png') });

  console.log('FPS:', await page.evaluate(()=>document.getElementById('fps').textContent));
  console.log('警告/エラー:', logs.length?logs:'なし');
} finally {
  if (app){ await new Promise(r=>setTimeout(r,300)); await app.close().catch(()=>{}); }
}
