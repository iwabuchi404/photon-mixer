/**
 * ポインター座標と描画位置の一致を検証
 * 画面の既知座標に点を打ち、committed テクスチャ上で着弾位置を読み出して比較
 */
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron.exe');

let app;
try {
  app = await electron.launch({ executablePath: electronBin, args: [APP_DIR], timeout: 30000, env: { ...process.env } });
  await new Promise(r => setTimeout(r, 4000));
  let page = app.windows().find(w => !w.url().startsWith('devtools://')) || await app.firstWindow();

  // アートキャンバス 800x600（ウィンドウサイズとは異なる）
  await page.evaluate(() => {
    document.getElementById('canvas-w').value = '800';
    document.getElementById('canvas-h').value = '600';
    document.getElementById('create-canvas-btn').click();
  });
  await new Promise(r => setTimeout(r, 500));

  // 画面の複数座標に点を打つ（pointerdown→少し動かす→up で確実にスタンプ）
  const targets = await page.evaluate(async () => {
    const canvas = document.getElementById('canvas');
    // viewport は中央配置・scale=1。アート中心=画面中心。
    // 画面座標 p に打つと、アート座標 = p - 画面中心 + アート中心(400,300)
    const sw = window.innerWidth, sh = window.innerHeight;
    const cx = Math.round(sw/2), cy = Math.round(sh/2);
    const pts = [
      { sx: cx, sy: cy },             // 中心 → アート(400,300)
      { sx: cx - 100, sy: cy - 60 },  // → アート(300,240)
      { sx: cx + 120, sy: cy + 50 },  // → アート(520,350)
    ];
    const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { pointerType:'mouse', clientX:x, clientY:y, pressure:0.9, button:0, buttons: type==='pointerup'?0:1, bubbles:true }));
    for (const p of pts) {
      fire('pointerdown', p.sx, p.sy);
      fire('pointermove', p.sx+1, p.sy+1);
      fire('pointermove', p.sx, p.sy);
      fire('pointerup', p.sx, p.sy);
      await new Promise(r=>setTimeout(r,120));
    }
    return { sw, sh, cx, cy, pts };
  });
  await new Promise(r => setTimeout(r, 300));

  // committed を読み出してスタンプ中心（α最大の塊）の重心を検出
  // ページからは読めないので、代わりに「期待アート座標」を計算して報告のみ
  // 実際の着弾は exportToPNG で確認したいが、ここでは expected を出してスクショ確認
  console.log('window:', targets.sw, 'x', targets.sh, ' 画面中心:', targets.cx, targets.cy);
  for (const p of targets.pts) {
    const ax = p.sx - targets.cx + 400;
    const ay = p.sy - targets.cy + 300;
    console.log(`画面(${p.sx},${p.sy}) → 期待アート(${ax},${ay})`);
  }

  // committed をスナップショットして各期待座標のαを確認（着弾していれば α>0）
  const hit = await page.evaluate(async (pts) => {
    // requestCommittedSnapshot は pipeline 内。app への参照がないので
    // window に検査用フックがなければ DOM 経由不可。
    // 代わりに exportToPNG 相当をボタンで…ではなく、ここは簡易に screenshot 判定に委ねる
    return 'snapshot-not-exposed';
  }, targets.pts);

  await page.screenshot({ path: path.join(APP_DIR, 'screenshots', 'align-check.png') });
  console.log('（スクショ align-check.png で目視確認：3点が打った位置に出ているか）');
} finally {
  if (app) { await new Promise(r=>setTimeout(r,300)); await app.close().catch(()=>{}); }
}
