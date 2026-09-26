/**
 * 入力記録の再生・検証スクリプト（D7）
 *
 * 使い方:
 *   node scripts/diag-input-replay.mjs                  # マウスで自キャプチャ→再生→一致確認
 *   node scripts/diag-input-replay.mjs --file rec.json  # 記録JSONを再生して統計を表示
 *   node scripts/diag-input-replay.mjs --capture        # キャプチャして pmx-input_capture.json に保存
 *
 * 実機での記録方法:
 *   アプリの DevTools で __pmxInput.start() → 描画 → __pmxInput.stop(true) でJSON DL
 */

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron.exe');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const recPath = arg('--file');
const doCapture = process.argv.includes('--capture');

function stats(events) {
  const moves = events.filter((e) => e.type === 'move');
  const ivs = moves.slice(1).map((e, i) => e.t - moves[i].t).filter((d) => d > 0);
  const avg = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : 0;
  const pressures = events.map((e) => e.pressure);
  const types = [...new Set(events.map((e) => e.pointerType))];
  return {
    events: events.length,
    moves: moves.length,
    durationMs: events.length ? events[events.length - 1].t - events[0].t : 0,
    avgIntervalMs: +avg.toFixed(2),
    pressureMin: Math.min(...pressures),
    pressureMax: Math.max(...pressures),
    pointerTypes: types.join(','),
  };
}

/** イベント列の一致度（再生→再記録のループバック検証用） */
function diffEvents(a, b) {
  if (a.length !== b.length) return `件数が違う: ${a.length} vs ${b.length}`;
  let mismatches = 0;
  for (let i = 0; i < a.length; i++) {
    for (const k of ['type', 'x', 'y', 'pressure', 'tiltX', 'tiltY', 'pointerType', 'eraser']) {
      if (a[i][k] !== b[i][k]) { mismatches++; break; }
    }
  }
  return mismatches === 0 ? '完全一致' : `${mismatches} 件不一致`;
}

console.log('=== 入力記録・再生診断（D7）===\n');

const app = await electron.launch({
  executablePath: electronBin,
  args: [APP_DIR],
  timeout: 30_000,
  env: { ...process.env },
});

await new Promise((r) => setTimeout(r, 5000));
const page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? (await app.firstWindow());

const hasApi = await page.evaluate(() => typeof globalThis.__pmxInput !== 'undefined');
if (!hasApi) {
  console.log('⚠ __pmxInput フックがありません。npm run build 済みか確認してください');
  await app.close();
  process.exit(1);
}

const canvasBox = await page.evaluate(() => {
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});

let rec;
if (recPath) {
  rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  console.log(`記録ファイル: ${recPath}`);
} else {
  console.log('--- 自キャプチャ（canvas へ合成 pointer イベントで曲線を描画）---');
  await page.evaluate(() => globalThis.__pmxInput.start());
  const cx = canvasBox.x + canvasBox.w / 2;
  const cy = canvasBox.y + canvasBox.h / 2;
  const evInit = (x, y, extra = {}) => ({
    pointerType: 'mouse', clientX: x, clientY: y,
    pressure: 0.5, button: 0, buttons: 1, pointerId: 1, isPrimary: true,
    ...extra,
  });
  await page.dispatchEvent('#canvas', 'pointerdown', evInit(cx - 200, cy));
  for (let i = 1; i <= 60; i++) {
    const t = i / 60;
    await page.dispatchEvent('#canvas', 'pointermove',
      evInit(cx - 200 + t * 400, cy + Math.sin(t * Math.PI * 4) * 30));
    await page.waitForTimeout(8);
  }
  await page.dispatchEvent('#canvas', 'pointerup', evInit(cx + 200, cy, { buttons: 0 }));
  rec = await page.evaluate(() => globalThis.__pmxInput.stop());
}

console.log('\n--- 記録統計 ---');
console.log(JSON.stringify(stats(rec.events), null, 2));

if (doCapture) {
  const out = path.join(APP_DIR, 'pmx-input_capture.json');
  fs.writeFileSync(out, JSON.stringify(rec));
  console.log(`保存: ${out}`);
}

// 再生 → 再記録して一致確認
console.log('\n--- 再生 + ループバック検証 ---');
const rerec = await page.evaluate(async (r) => {
  const api = globalThis.__pmxInput;
  api.start();
  await api.replay(r);
  return api.stop();
}, rec);
console.log(`再生→再記録: ${diffEvents(rec.events, rerec.events)}`);

await app.close();
console.log('\n完了');
