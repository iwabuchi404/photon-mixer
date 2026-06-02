/**
 * Block 6.5 Phase A 検証: 左右反転・ブラシカーソル・ショートカット([ ], H, Tab)
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
const key = (page, k, opts={}) => page.evaluate(([kk,o])=>window.dispatchEvent(new KeyboardEvent('keydown',{key:kk,bubbles:true,...o})), [k,opts]);

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

  // 左寄りに「L」字（縦棒+下の横棒）を描いて、反転で右に来ることを確認
  await page.evaluate(()=>{ const s=document.getElementById('brush-size'); s.value='24'; s.dispatchEvent(new Event('input')); });
  await page.evaluate(()=>{ const p=document.getElementById('brush-color'); p.value='#ffffff'; p.dispatchEvent(new Event('input')); });
  await stroke(page, cx-180, cy-100, cx-180, cy+100, 30); // 縦棒（左寄り）
  await stroke(page, cx-180, cy+100, cx-60, cy+100, 20);   // 下の横棒（右向き）
  await page.screenshot({ path: path.join(SHOT_DIR,'phaseA-1-normal.png') });

  // H で左右反転 → L が右側に移り、横棒は左向きになるはず
  await key(page, 'h');
  await new Promise(r=>setTimeout(r,150));
  await page.screenshot({ path: path.join(SHOT_DIR,'phaseA-2-flipped.png') });

  // [ でサイズダウン x3、] でアップ x1 → 同期確認
  await key(page,'['); await key(page,'['); await key(page,'[');
  const sizeAfter = await page.evaluate(()=>({slider:document.getElementById('brush-size').value, num:document.getElementById('brush-size-num').value}));
  console.log('[x3 後サイズ:', JSON.stringify(sizeAfter), '（24-6=18 期待）');

  // ブラシカーソル: mousemove で表示されるか
  await page.evaluate(([x,y])=>window.dispatchEvent(new MouseEvent('mousemove',{clientX:x,clientY:y,bubbles:true})), [cx,cy]);
  await new Promise(r=>setTimeout(r,100));
  const cursor = await page.evaluate(()=>{ const el=document.getElementById('brush-cursor'); return { display: el.style.display, w: el.style.width, left: el.style.left }; });
  console.log('ブラシカーソル:', JSON.stringify(cursor));

  // Tab で UI 非表示
  await key(page,'Tab');
  await new Promise(r=>setTimeout(r,100));
  const uiHidden = await page.evaluate(()=>document.getElementById('brush-controls').style.display);
  console.log('Tab 後 brush-controls display:', uiHidden, '（none 期待）');
  await key(page,'Tab'); // 戻す
  await new Promise(r=>setTimeout(r,100));

  // 入力欄フォーカス中はショートカット抑制（数値入力にフォーカスして b を投げる→ツール変わらない）
  await page.evaluate(()=>document.getElementById('brush-size-num').focus());
  await page.evaluate(()=>document.getElementById('brush-size-num').dispatchEvent(new KeyboardEvent('keydown',{key:'b',bubbles:true})));
  // window リスナーは activeElement を見るので、フォーカス中は抑制されるはず
  await new Promise(r=>setTimeout(r,80));
  const toolActive = await page.evaluate(()=>document.querySelector('#tool-brush').classList.contains('active'));
  console.log('入力欄フォーカス中の b 抑制（brushツールはアクティブのまま）:', toolActive);

  console.log('FPS:', await page.evaluate(()=>document.getElementById('fps').textContent));
  console.log('警告/エラー:', logs.length?logs:'なし');
} finally {
  if (app){ await new Promise(r=>setTimeout(r,300)); await app.close().catch(()=>{}); }
}
