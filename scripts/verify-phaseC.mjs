/**
 * Block 6.5 Phase C 検証: 直線ツール・ぼかし筆・補正UI・筆圧カーブ
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

  // 直線ツール: 斜め線
  await page.evaluate(()=>{ const s=document.getElementById('brush-size'); s.value='12'; s.dispatchEvent(new Event('input')); });
  await setColor(page,'#cc0000');
  await page.evaluate(()=>document.getElementById('tool-line').click());
  await stroke(page, cx-200, cy-100, cx+200, cy+60, 20); // down→move→up で直線確定
  await page.screenshot({ path: path.join(SHOT_DIR,'phaseC-1-line.png') });

  // ぼかし筆: 赤の隣に青を置いて境界をぼかす
  await page.evaluate(()=>document.getElementById('tool-brush').click());
  await page.evaluate(()=>{ const s=document.getElementById('brush-size'); s.value='40'; s.dispatchEvent(new Event('input')); });
  await setColor(page,'#cc0000'); await stroke(page, cx-150, cy+150, cx, cy+150, 20);
  await setColor(page,'#0000cc'); await stroke(page, cx, cy+150, cx+150, cy+150, 20);
  await page.screenshot({ path: path.join(SHOT_DIR,'phaseC-2-before-blur.png') });
  // ぼかしツールで境界をなぞる
  await page.evaluate(()=>document.getElementById('tool-blur').click());
  await stroke(page, cx-60, cy+150, cx+60, cy+150, 25);
  await stroke(page, cx-60, cy+150, cx+60, cy+150, 25);
  await page.screenshot({ path: path.join(SHOT_DIR,'phaseC-3-after-blur.png') });

  // 補正UI・筆圧カーブの反映確認（値だけ）
  await page.evaluate(()=>{ const s=document.getElementById('brush-stabilize'); s.value='80'; s.dispatchEvent(new Event('input')); });
  await page.evaluate(()=>{ const s=document.getElementById('pressure-curve'); s.value='ease-in'; s.dispatchEvent(new Event('change')); });
  const ui = await page.evaluate(()=>({ stab: document.getElementById('brush-stabilize-val').textContent, curve: document.getElementById('pressure-curve').value }));
  console.log('補正UI:', JSON.stringify(ui));

  console.log('FPS:', await page.evaluate(()=>document.getElementById('fps').textContent));
  console.log('警告/エラー:', logs.length?logs:'なし');
} finally {
  if (app){ await new Promise(r=>setTimeout(r,300)); await app.close().catch(()=>{}); }
}
