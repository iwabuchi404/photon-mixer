/**
 * Block 6.5 Phase B 検証: 塗りつぶし許容値・背景色
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
const setColor=(page,hex)=>page.evaluate(h=>{const p=document.getElementById('brush-color');p.value=h;p.dispatchEvent(new Event('input'));},hex);

let app;
try {
  app = await electron.launch({ executablePath: electronBin, args:[APP_DIR], timeout:30000, env:{...process.env} });
  await new Promise(r=>setTimeout(r,4000));
  let page = app.windows().find(w=>!w.url().startsWith('devtools://')) || await app.firstWindow();
  // confirm（自動保存復元）を自動で閉じる
  page.on('dialog', d=>d.dismiss().catch(()=>{}));
  const logs=[]; page.on('console',m=>{ if(m.type()==='error'||m.type()==='warning') logs.push(`[${m.type()}] ${m.text()}`); });

  await page.evaluate(()=>{ document.getElementById('canvas-w').value='800'; document.getElementById('canvas-h').value='600'; document.getElementById('create-canvas-btn').click(); });
  await new Promise(r=>setTimeout(r,500));
  const sz = await page.evaluate(()=>({cw:document.getElementById('canvas').width, ch:document.getElementById('canvas').height}));
  const cx=Math.round(sz.cw/2), cy=Math.round(sz.ch/2);

  // 背景=白 にしてストロークが映えるようにする
  await page.evaluate(()=>document.getElementById('bg-white').click());
  await new Promise(r=>setTimeout(r,100));
  await page.screenshot({ path: path.join(SHOT_DIR,'phaseB-1-bg-white.png') });

  // 黒の輪郭（閉じた四角）を描いてバケツで内側を塗る
  await page.evaluate(()=>{ const s=document.getElementById('brush-size'); s.value='10'; s.dispatchEvent(new Event('input')); });
  await setColor(page,'#000000');
  await stroke(page, cx-120, cy-90, cx+120, cy-90, 30); // 上辺
  await stroke(page, cx+120, cy-90, cx+120, cy+90, 30); // 右辺
  await stroke(page, cx+120, cy+90, cx-120, cy+90, 30); // 下辺
  await stroke(page, cx-120, cy+90, cx-120, cy-90, 30); // 左辺

  // 許容値を上げる（アンチエイリアス境界も塗れるように）
  await page.evaluate(()=>{ const s=document.getElementById('bucket-tolerance'); s.value='30'; s.dispatchEvent(new Event('input')); });
  // 緑バケツで内側
  await setColor(page,'#00aa00');
  await page.evaluate(()=>document.getElementById('tool-bucket').click());
  await ptr(page,'pointerdown', cx, cy);
  await new Promise(r=>setTimeout(r,400));
  await page.screenshot({ path: path.join(SHOT_DIR,'phaseB-2-bucket-tol.png') });

  // 背景=透明に戻す
  await page.evaluate(()=>document.getElementById('bg-transparent').click());
  await new Promise(r=>setTimeout(r,100));
  await page.screenshot({ path: path.join(SHOT_DIR,'phaseB-3-bg-transparent.png') });

  console.log('FPS:', await page.evaluate(()=>document.getElementById('fps').textContent));
  console.log('警告/エラー:', logs.length?logs:'なし');
} finally {
  if (app){ await new Promise(r=>setTimeout(r,300)); await app.close().catch(()=>{}); }
}
