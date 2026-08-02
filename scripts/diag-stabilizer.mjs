/**
 * 手ブレ補正の効きを診断するスクリプト v4
 * アプリ内の handleStampMove に仕込んだデバッグフックで
 * 生点 vs 補正後の点を直接記録して数値比較する
 */

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron.exe');

console.log('=== 手ブレ補正診断 v4（アプリ内フック）===\n');

const app = await electron.launch({
  executablePath: electronBin,
  args: [APP_DIR],
  timeout: 30_000,
  env: { ...process.env },
});

await new Promise(r => setTimeout(r, 5000));
const page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? await app.firstWindow();

const canvasBox = await page.evaluate(() => {
  const c = document.getElementById('canvas');
  const r = c.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
});
const cx = canvasBox.x + canvasBox.width / 2;
const cy = canvasBox.y + canvasBox.height / 2;

// デバッグフックを有効化
await page.evaluate(() => { (globalThis).__stabDiag = { enabled: true }; });

function jitterScore(pts) {
  let total = 0;
  for (let i = 2; i < pts.length; i++) {
    const dx1 = pts[i].x - pts[i-1].x, dy1 = pts[i].y - pts[i-1].y;
    const dx2 = pts[i-1].x - pts[i-2].x, dy2 = pts[i-1].y - pts[i-2].y;
    const a1 = Math.atan2(dy1, dx1), a2 = Math.atan2(dy2, dx2);
    let da = a1 - a2;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    total += Math.abs(da);
  }
  return total;
}

async function drawCurve(startX, startY) {
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const x = startX + t * 400;
    const y = startY + Math.sin(t * Math.PI * 4) * 20 + (Math.random() - 0.5) * 5;
    await page.mouse.move(x, y);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await new Promise(r => setTimeout(r, 300));
  return page.evaluate(() => {
    const d = (globalThis).__stabDiag;
    return {
      raw: d.rawPoints || [],
      stabilized: d.stabilizedPoints || [],
      config: d.config,
    };
  });
}

// --- 0% で描画 ---
console.log('--- 0% で描画 ---');
await page.evaluate(() => {
  const s = document.getElementById('brush-stabilize');
  s.value = '0'; s.dispatchEvent(new Event('input', { bubbles: true }));
});
await new Promise(r => setTimeout(r, 300));
const result0 = await drawCurve(cx - 200, cy);
console.log(`  config: ${JSON.stringify(result0.config)}`);
console.log(`  raw点数: ${result0.raw.length}, stabilized点数: ${result0.stabilized.length}`);
console.log(`  raw ブレ量: ${jitterScore(result0.raw).toFixed(3)}`);
console.log(`  stabilized ブレ量: ${jitterScore(result0.stabilized).toFixed(3)}`);
// 最後の5点を表示
console.log(`  raw 最後の5点:`);
result0.raw.slice(-5).forEach((p, i) => console.log(`    [${i}] x=${p.x.toFixed(1)}, y=${p.y.toFixed(1)}`));
console.log(`  stabilized 最後の5点:`);
result0.stabilized.slice(-5).forEach((p, i) => console.log(`    [${i}] x=${p.x.toFixed(1)}, y=${p.y.toFixed(1)}`));

// --- 100% で描画 ---
console.log('\n--- 100% で描画 ---');
await page.evaluate(() => {
  const s = document.getElementById('brush-stabilize');
  s.value = '100'; s.dispatchEvent(new Event('input', { bubbles: true }));
});
await new Promise(r => setTimeout(r, 300));
const result100 = await drawCurve(cx - 200, cy + 150);
console.log(`  config: ${JSON.stringify(result100.config)}`);
console.log(`  raw点数: ${result100.raw.length}, stabilized点数: ${result100.stabilized.length}`);
console.log(`  raw ブレ量: ${jitterScore(result100.raw).toFixed(3)}`);
console.log(`  stabilized ブレ量: ${jitterScore(result100.stabilized).toFixed(3)}`);
console.log(`  raw 最後の5点:`);
result100.raw.slice(-5).forEach((p, i) => console.log(`    [${i}] x=${p.x.toFixed(1)}, y=${p.y.toFixed(1)}`));
console.log(`  stabilized 最後の5点:`);
result100.stabilized.slice(-5).forEach((p, i) => console.log(`    [${i}] x=${p.x.toFixed(1)}, y=${p.y.toFixed(1)}`));

// --- 比較サマリ ---
console.log('\n=== 比較サマリ ===');
const rawJ0 = jitterScore(result0.raw);
const stabJ0 = jitterScore(result0.stabilized);
const rawJ100 = jitterScore(result100.raw);
const stabJ100 = jitterScore(result100.stabilized);
console.log(`  0%:   raw=${rawJ0.toFixed(2)} → stabilized=${stabJ0.toFixed(2)} (変化率: ${((stabJ0/rawJ0-1)*100).toFixed(1)}%)`);
console.log(`  100%: raw=${rawJ100.toFixed(2)} → stabilized=${stabJ100.toFixed(2)} (変化率: ${((stabJ100/rawJ100-1)*100).toFixed(1)}%)`);

if (Math.abs(stabJ0 - rawJ0) < 0.1 && Math.abs(stabJ100 - rawJ100) < 0.1) {
  console.log(`  → ⚠ 0%も100%も stabilized が raw とほぼ同じ = 補正が効いていない！`);
} else if (Math.abs(stabJ0 - rawJ0) < 0.1) {
  console.log(`  → 0%は補正なし（正しい）、100%は補正あり（${((1-stabJ100/rawJ100)*100).toFixed(0)}%減）`);
} else {
  console.log(`  → 0%でも補正がかかっている可能性（minAlphaが1.0になっていない？）`);
}

// 最後の点のズレ（lag）を確認
const lastRaw0 = result0.raw[result0.raw.length - 1];
const lastStab0 = result0.stabilized[result0.stabilized.length - 1];
const lastRaw100 = result100.raw[result100.raw.length - 1];
const lastStab100 = result100.stabilized[result100.stabilized.length - 1];
const lag0 = Math.hypot(lastRaw0.x - lastStab0.x, lastRaw0.y - lastStab0.y);
const lag100 = Math.hypot(lastRaw100.x - lastStab100.x, lastRaw100.y - lastStab100.y);
console.log(`\n  最終点のズレ（lag）:`);
console.log(`    0%:   ${lag0.toFixed(1)} px`);
console.log(`    100%: ${lag100.toFixed(1)} px`);
if (lag100 < 1.0) {
  console.log(`    → ⚠ 100%でもズレがほぼゼロ = 補正が効いていない！`);
} else {
  console.log(`    → 100%で ${lag100.toFixed(1)}px のズレ = 補正は効いている`);
}

await app.close();
