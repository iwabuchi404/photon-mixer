/**
 * Block 6.5 E-1/E-2 検証: HSVピッカー・パレット
 */
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(APP_DIR, 'screenshots');
const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron.exe');

let app;
try {
  app = await electron.launch({ executablePath: electronBin, args:[APP_DIR], timeout:30000, env:{...process.env} });
  await new Promise(r=>setTimeout(r,4000));
  let page = app.windows().find(w=>!w.url().startsWith('devtools://')) || await app.firstWindow();
  page.on('dialog', d=>d.dismiss().catch(()=>{}));
  const logs=[]; page.on('console',m=>{ if(m.type()==='error'||m.type()==='warning') logs.push(`[${m.type()}] ${m.text()}`); });

  await page.evaluate(()=>{ document.getElementById('canvas-w').value='800'; document.getElementById('canvas-h').value='600'; document.getElementById('create-canvas-btn').click(); });
  await new Promise(r=>setTimeout(r,500));

  // 色相バーをクリックして色相を変える（左から1/6 ≒ 黄, 中央 ≒ シアン）
  const hueCanvas = await page.evaluateHandle(()=>document.querySelector('#color-picker canvas:nth-child(2)'));
  const box = await page.evaluate(()=>{ const c=document.querySelector('#color-picker canvas:nth-child(2)'); const r=c.getBoundingClientRect(); return {x:r.left, y:r.top, w:r.width, h:r.height}; });
  // 色相 ~ 中央（シアン 180度付近）
  await page.evaluate(([x,y])=>{ const c=document.querySelector('#color-picker canvas:nth-child(2)'); c.dispatchEvent(new MouseEvent('mousedown',{clientX:x,clientY:y,bubbles:true})); window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }, [box.x+box.w*0.5, box.y+box.h/2]);
  await new Promise(r=>setTimeout(r,100));

  // SVボックスで彩度・明度を選ぶ（右上＝高彩度・高明度）
  const sv = await page.evaluate(()=>{ const c=document.querySelector('#color-picker canvas:nth-child(1)'); const r=c.getBoundingClientRect(); return {x:r.left, y:r.top, w:r.width, h:r.height}; });
  await page.evaluate(([x,y])=>{ const c=document.querySelector('#color-picker canvas:nth-child(1)'); c.dispatchEvent(new MouseEvent('mousedown',{clientX:x,clientY:y,bubbles:true})); window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }, [sv.x+sv.w*0.9, sv.y+sv.h*0.1]);
  await new Promise(r=>setTimeout(r,100));

  const hex1 = await page.evaluate(()=>document.getElementById('brush-color').value);
  console.log('色相中央・右上で選んだ色:', hex1, '（シアン系 期待）');

  // 色を保存（スウォッチ）
  await page.evaluate(()=>{ [...document.querySelectorAll('#color-picker button')].find(b=>b.textContent.includes('保存'))?.click(); });
  const swatchCount = await page.evaluate(()=>document.querySelectorAll('#cp-palette > div').length);
  console.log('パレットのチップ数（履歴+スウォッチ）:', swatchCount);

  await page.screenshot({ path: path.join(SHOT_DIR,'colorpicker-1.png') });

  console.log('警告/エラー:', logs.length?logs:'なし');
} finally {
  if (app){ await new Promise(r=>setTimeout(r,300)); await app.close().catch(()=>{}); }
}
