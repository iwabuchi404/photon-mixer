/**
 * 引きずり混色デバッグ - アプリ内部状態を直接検査
 */

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(APP_DIR, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron.exe');

async function ptr(page, type, x, y) {
  await page.dispatchEvent('#canvas', type, {
    pointerType: 'mouse', clientX: x, clientY: y,
    pressure: 0.5, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  });
}

let app;
try {
  app = await electron.launch({
    executablePath: electronBin,
    args: [APP_DIR],
    timeout: 30_000,
    env: { ...process.env },
  });

  await new Promise(r => setTimeout(r, 4000));
  let page = app.windows().find(w => !w.url().startsWith('devtools://'));
  if (!page) page = await app.firstWindow();

  const { cw, ch } = await page.evaluate(() => ({
    cw: document.getElementById('canvas').width,
    ch: document.getElementById('canvas').height,
  }));
  console.log(`Canvas resolution: ${cw}x${ch}`);

  const cx = Math.round(cw / 2);
  const cy = Math.round(ch / 2);

  // コンソールメッセージをキャプチャ
  const logs = [];
  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

  // デバッグ用の console.log をページに注入してアプリ内部から叩けるようにする
  // window.__mixDebug フラグを使ってログを収集
  await page.evaluate(() => {
    window.__mixLogs = [];
    window.__mixDebugEnabled = true;
  });

  // === 赤い縦線を描く ===
  await page.evaluate(() => {
    document.getElementById('brush-color').value = '#ff0000';
    document.getElementById('brush-color').dispatchEvent(new Event('input'));
  });

  await ptr(page, 'pointerdown', cx, cy - 100);
  for (let i = 1; i <= 30; i++) {
    await ptr(page, 'pointermove', cx, cy - 100 + i * 7);
    await new Promise(r => setTimeout(r, 10));
  }
  await ptr(page, 'pointerup', cx, cy + 100);
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(SHOT_DIR, '01-red.png') });
  console.log('赤線描画完了');

  // === 引きずりモード設定 ===
  await page.evaluate(() => {
    document.getElementById('brush-color').value = '#ffffff';
    document.getElementById('brush-color').dispatchEvent(new Event('input'));
    document.getElementById('mix-mode').value = 'progressive';
    document.getElementById('mix-mode').dispatchEvent(new Event('change'));
    document.getElementById('brush-wet').value = '80';
    document.getElementById('brush-wet').dispatchEvent(new Event('input'));
  });
  await new Promise(r => setTimeout(r, 100));

  // === pen-down でスナップショット開始 ===
  await ptr(page, 'pointerdown', cx - 150, cy);
  console.log('pen-down: スナップショット取得開始...');
  await new Promise(r => setTimeout(r, 1500)); // スナップショット完了を待つ

  // スナップショット取得状況を確認
  // ページ内に window.__snapshotReady という変数を仕込む方法がないので
  // 代わりに GPU readback テストを実施
  const snapshotTest = await page.evaluate(async () => {
    // requestCommittedSnapshot を公開されたメソッドから呼ぶことはできないが
    // 代わりに canvas 2D で committed texture の内容を確認できないか試みる
    // (WebGPU は直接読み出せないので別アプローチ)

    // 単純に現在のアプリ状態を JSON で返す
    // PhotonMixerApp のプライベートフィールドにはアクセスできないので
    // window.photoMixerDebug を仕掛けるには main.ts の修正が必要

    return {
      canvasWidth:  document.getElementById('canvas').width,
      wetSlider:    document.getElementById('brush-wet').value,
      mode:         document.getElementById('mix-mode').value,
      note: 'snapshot should be ready after 1.5s wait',
    };
  });
  console.log('スナップショット待機後の状態:', JSON.stringify(snapshotTest));

  // === ゆっくり横切る（各点のログを確認） ===
  console.log('\n移動開始:');
  const moveLog = [];
  for (let i = 1; i <= 30; i++) {
    const t = i / 30;
    const x = Math.round(cx - 150 + 300 * t);
    await ptr(page, 'pointermove', x, cy);

    // 各移動後のスクリーンの状態（Pointsカウンタ）を確認
    const pts = await page.evaluate(() =>
      parseInt(document.getElementById('points').textContent || '0')
    );
    moveLog.push({ x, pts });
    await new Promise(r => setTimeout(r, 30));
  }

  await ptr(page, 'pointerup', cx + 150, cy);
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(SHOT_DIR, '02-crossing.png') });

  // Pointsの変化（commitProgressiveSegmentが呼ばれているか確認）
  console.log('移動ログ（各移動でのPoints数）:');
  for (const m of moveLog) {
    if (Math.abs(m.x - cx) < 50) {
      console.log(`  x=${m.x} (赤線付近): Points=${m.pts}`);
    }
  }
  console.log(`  最終Points: ${moveLog[moveLog.length-1].pts}`);

  // === ピクセル色を直接確認 ===
  // canvas の 2D コンテキストは WebGPU canvas では使えないので
  // スクリーンショットのピクセルを Playwright で読む
  const crossPixel = await page.evaluate(() => {
    // WebGPU canvas は toDataURL 非対応なので別途確認
    return { note: 'WebGPU canvas pixel readback not available via DOM' };
  });

  // コンソールログを全部出力
  console.log('\nコンソールログ:');
  for (const l of logs) console.log(' ', l);

} finally {
  if (app) {
    await new Promise(r => setTimeout(r, 500));
    await app.close().catch(() => {});
  }
}
