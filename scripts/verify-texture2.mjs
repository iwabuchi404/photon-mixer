/**
 * Block 4 修正検証: 輝度マスク（グレースケール素材）＋プリセット往復
 */
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
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

  await page.evaluate(() => {
    document.getElementById('canvas-w').value = '800';
    document.getElementById('canvas-h').value = '600';
    document.getElementById('create-canvas-btn').click();
  });
  await new Promise(r => setTimeout(r, 500));
  const sz = await page.evaluate(() => ({ cw: document.getElementById('canvas').width, ch: document.getElementById('canvas').height }));
  const scx = Math.round(sz.cw/2), scy = Math.round(sz.ch/2);

  // グレースケール（αなし）の横縞テクスチャを読み込む → 輝度マスクで縞が出るはず
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(64, 64);
    for (let y=0;y<64;y++) for (let x=0;x<64;x++){
      const i=(y*64+x)*4;
      const v = (Math.floor(y/8)%2===0) ? 255 : 0; // 横縞（白/黒）
      img.data[i]=v; img.data[i+1]=v; img.data[i+2]=v;
      img.data[i+3]=255; // αは常に不透明（輝度マスクのテスト）
    }
    ctx.putImageData(img,0,0);
    const blob = await new Promise(res => c.toBlob(res,'image/png'));
    const file = new File([blob], 'gray.png', { type:'image/png' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.getElementById('texture-file-input');
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 600));
  await page.evaluate(() => { const s=document.getElementById('texture-scale'); s.value='15'; s.dispatchEvent(new Event('input')); });
  await page.evaluate(() => { const p=document.getElementById('brush-color'); p.value='#ffffff'; p.dispatchEvent(new Event('input')); });
  await stroke(page, scx-200, scy-60, scx+200, scy-60);
  await page.screenshot({ path: path.join(SHOT_DIR, 'tex2-1-luminance.png') });

  // プリセット保存（テクスチャ込み）→ ページ内で blob を捕捉
  const presetB64 = await page.evaluate(async () => {
    // savePreset を直接は呼べないので、保存ボタンの download をフックする代わりに
    // BrushPresetManager を import 済みの main から…はできないので、
    // ここでは保存ボタンを押して a.click を乗っ取り blob を取得
    return await new Promise((resolve) => {
      const origCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        blob.arrayBuffer().then(buf => {
          const bytes = new Uint8Array(buf);
          let bin=''; for (const b of bytes) bin+=String.fromCharCode(b);
          resolve(btoa(bin));
        });
        URL.createObjectURL = origCreate;
        return 'blob:dummy';
      };
      document.getElementById('save-preset-btn').click();
    });
  });
  console.log('プリセットZIPサイズ(base64長):', presetB64.length);

  // テクスチャをクリア（円形に戻す）
  await page.evaluate(() => document.getElementById('clear-texture-btn').click());

  // 保存したプリセットを読み込み（file input 経由）→ テクスチャが復活するはず
  await page.evaluate(async (b64) => {
    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
    const file = new File([bytes], 'preset.zip', { type:'application/zip' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.getElementById('preset-file-input');
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, presetB64);
  await new Promise(r => setTimeout(r, 800));
  // alert を閉じる
  await page.evaluate(() => { /* alert は自動で出るが playwright はブロックしない */ });

  // プリセット読込後にテクスチャブラシで描く → 縞が出れば往復成功
  await page.evaluate(() => { const p=document.getElementById('brush-color'); p.value='#ff8800'; p.dispatchEvent(new Event('input')); });
  await stroke(page, scx-200, scy+60, scx+200, scy+60);
  await page.screenshot({ path: path.join(SHOT_DIR, 'tex2-2-preset-roundtrip.png') });

  const st = await page.evaluate(() => ({
    scale: document.getElementById('texture-scale').value,
  }));
  console.log('読込後スケール:', st.scale);
  console.log('FPS:', await page.evaluate(() => document.getElementById('fps').textContent));
  console.log('警告/エラー:', logs.length ? logs : 'なし');
} finally {
  if (app) { await new Promise(r=>setTimeout(r,300)); await app.close().catch(()=>{}); }
}
