/**
 * Block 6 検証: .pmx 保存→クリア→読込でレイヤー構成と内容が往復するか
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
  const logs=[]; page.on('console',m=>{ if(m.type()==='error'||m.type()==='warning') logs.push(`[${m.type()}] ${m.text()}`); });

  await page.evaluate(()=>{ document.getElementById('canvas-w').value='800'; document.getElementById('canvas-h').value='600'; document.getElementById('create-canvas-btn').click(); });
  await new Promise(r=>setTimeout(r,500));
  const sz = await page.evaluate(()=>({cw:document.getElementById('canvas').width, ch:document.getElementById('canvas').height}));
  const cx=Math.round(sz.cw/2), cy=Math.round(sz.ch/2);

  // レイヤー1: 赤、レイヤー2(乗算): 青
  await page.evaluate(()=>{ const s=document.getElementById('brush-size'); s.value='70'; s.dispatchEvent(new Event('input')); });
  await setColor(page,'#ff0000'); await stroke(page,cx-150,cy-15,cx+150,cy-15,30);
  await page.evaluate(()=>document.getElementById('layer-add').click());
  await setColor(page,'#0066ff'); await stroke(page,cx-150,cy+15,cx+150,cy+15,30);
  await page.evaluate(()=>{ const sels=document.querySelectorAll('#layer-list select'); sels[0].value='multiply'; sels[0].dispatchEvent(new Event('change')); });
  await new Promise(r=>setTimeout(r,150));
  await page.screenshot({ path: path.join(SHOT_DIR,'pmx-1-before.png') });

  // 保存（download blob を捕捉）
  const pmxB64 = await page.evaluate(async ()=>{
    return await new Promise((resolve)=>{
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob)=>{ blob.arrayBuffer().then(buf=>{ const b=new Uint8Array(buf); let s=''; for(const x of b) s+=String.fromCharCode(x); resolve(btoa(s)); }); URL.createObjectURL=orig; return 'blob:dummy'; };
      document.getElementById('save-pmx-btn').click();
    });
  });
  console.log('.pmx サイズ(base64長):', pmxB64.length);

  // 全消し（クリア＋レイヤー削除でレイヤー2のみ残す→さらにクリア）
  await page.evaluate(()=>{ document.getElementById('clear-btn').click(); });
  await page.evaluate(()=>{ document.getElementById('layer-del').click(); }); // レイヤー2削除
  await page.evaluate(()=>{ document.getElementById('clear-btn').click(); }); // レイヤー1もクリア
  await new Promise(r=>setTimeout(r,150));
  await page.screenshot({ path: path.join(SHOT_DIR,'pmx-2-cleared.png') });

  // 読み込み
  await page.evaluate(async (b64)=>{
    const bin=atob(b64); const bytes=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
    const file=new File([bytes],'test.pmx',{type:'application/octet-stream'});
    const dt=new DataTransfer(); dt.items.add(file);
    const input=document.getElementById('pmx-file-input'); input.files=dt.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  }, pmxB64);
  await new Promise(r=>setTimeout(r,800));
  await page.screenshot({ path: path.join(SHOT_DIR,'pmx-3-loaded.png') });

  const layerCount = await page.evaluate(()=>document.querySelectorAll('#layer-list > div').length);
  const modes = await page.evaluate(()=>[...document.querySelectorAll('#layer-list select')].map(s=>s.value));
  console.log('読込後レイヤー数:', layerCount, ' 合成モード:', JSON.stringify(modes));
  console.log('FPS:', await page.evaluate(()=>document.getElementById('fps').textContent));
  console.log('警告/エラー:', logs.length?logs:'なし');
} finally {
  if (app){ await new Promise(r=>setTimeout(r,300)); await app.close().catch(()=>{}); }
}
