/**
 * Block 5 検証: レイヤー追加・合成モード・不透明度・表示切替・per-layer Undo
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
async function stroke(page, x1, y1, x2, y2, n=25) {
  await ptr(page,'pointerdown',x1,y1);
  for (let i=1;i<=n;i++){ await ptr(page,'pointermove',Math.round(x1+(x2-x1)*i/n),Math.round(y1+(y2-y1)*i/n)); await new Promise(r=>setTimeout(r,8)); }
  await ptr(page,'pointerup',x2,y2);
  await new Promise(r=>setTimeout(r,150));
}
const setColor = (page,hex)=>page.evaluate(h=>{const p=document.getElementById('brush-color');p.value=h;p.dispatchEvent(new Event('input'));},hex);

let app;
try {
  app = await electron.launch({ executablePath: electronBin, args:[APP_DIR], timeout:30000, env:{...process.env} });
  await new Promise(r=>setTimeout(r,4000));
  let page = app.windows().find(w=>!w.url().startsWith('devtools://')) || await app.firstWindow();
  const logs=[]; page.on('console',m=>{ if(m.type()==='error'||m.type()==='warning') logs.push(`[${m.type()}] ${m.text()}`); });

  await page.evaluate(()=>{ document.getElementById('canvas-w').value='800'; document.getElementById('canvas-h').value='600'; document.getElementById('create-canvas-btn').click(); });
  await new Promise(r=>setTimeout(r,500));
  const sz = await page.evaluate(()=>({cw:document.getElementById('canvas').width, ch:document.getElementById('canvas').height}));
  const cx=Math.round(sz.cw/2), cy=Math.round(sz.ch/2);

  // レイヤー1: 赤い横長矩形（太いストローク）
  await setColor(page,'#ff0000');
  await page.evaluate(()=>{ const s=document.getElementById('brush-size'); s.value='80'; s.dispatchEvent(new Event('input')); });
  await stroke(page, cx-150, cy-20, cx+150, cy-20, 30);

  // レイヤー追加 → レイヤー2
  await page.evaluate(()=>document.getElementById('layer-add').click());
  const layerCount1 = await page.evaluate(()=>document.querySelectorAll('#layer-list > div').length);
  console.log('レイヤー数(追加後):', layerCount1);

  // レイヤー2: 青い横長矩形を少しずらして重ねる
  await setColor(page,'#0066ff');
  await stroke(page, cx-150, cy+20, cx+150, cy+20, 30);
  await page.screenshot({ path: path.join(SHOT_DIR,'layer-1-normal.png') });

  // レイヤー2を乗算に
  await page.evaluate(()=>{ const sel=document.getElementById('strip-blend-mode'); sel.value='multiply'; sel.dispatchEvent(new Event('change')); });
  await new Promise(r=>setTimeout(r,150));
  await page.screenshot({ path: path.join(SHOT_DIR,'layer-2-multiply.png') });

  // レイヤー2の不透明度を50%に
  await page.evaluate(()=>{ const op=document.getElementById('strip-opacity'); op.value='50'; op.dispatchEvent(new Event('input')); });
  await new Promise(r=>setTimeout(r,150));
  await page.screenshot({ path: path.join(SHOT_DIR,'layer-3-opacity.png') });

  // レイヤー2を非表示
  await page.evaluate(()=>document.querySelector('#layer-list .layer-row.active .layer-eye').click());
  await new Promise(r=>setTimeout(r,150));
  await page.screenshot({ path: path.join(SHOT_DIR,'layer-4-hidden.png') });

  // 再表示
  await page.evaluate(()=>document.querySelector('#layer-list .layer-row.active .layer-eye').click());
  await new Promise(r=>setTimeout(r,150));

  // per-layer Undo: アクティブ(レイヤー2)で Undo → 青だけ消える、赤は残る
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true})));
  await new Promise(r=>setTimeout(r,200));
  await page.screenshot({ path: path.join(SHOT_DIR,'layer-5-undo-active.png') });

  console.log('FPS:', await page.evaluate(()=>document.getElementById('fps').textContent));
  console.log('警告/エラー:', logs.length?logs:'なし');
} finally {
  if (app){ await new Promise(r=>setTimeout(r,300)); await app.close().catch(()=>{}); }
}
