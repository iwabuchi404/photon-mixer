/**
 * ペン機能検証スクリプト
 * Electron アプリを起動し、マウスで線を描いてスクリーンショットを撮る
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

console.log('PhotonMixer ペン機能検証');
console.log('APP_DIR:', APP_DIR);
console.log('Electron:', electronBin);

let app;
try {
  app = await electron.launch({
    executablePath: electronBin,
    args: [APP_DIR],
    timeout: 30_000,
    env: { ...process.env },
  });
  console.log('Electron 起動完了');

  // メインウィンドウを取得（DevTools以外）
  await new Promise(r => setTimeout(r, 4000));
  let page = app.windows().find(w => !w.url().startsWith('devtools://'));
  if (!page) page = await app.firstWindow();

  console.log('ウィンドウ URL:', page.url());
  console.log('ウィンドウ数:', app.windows().length);

  // 起動直後のスクリーンショット
  const shot1 = path.join(SHOT_DIR, '01-startup.png');
  await page.screenshot({ path: shot1 });
  console.log('起動スクリーンショット:', shot1);

  // WebGPU の状態を確認
  const gpuStatus = await page.evaluate(async () => {
    const hasGPU = !!navigator.gpu;
    let adapterOk = false;
    let errorMsg = null;
    if (hasGPU) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        adapterOk = !!adapter;
      } catch (e) {
        errorMsg = e.message;
      }
    }
    return { hasGPU, adapterOk, errorMsg };
  });
  console.log('WebGPU 状態:', JSON.stringify(gpuStatus));

  // コンソールエラーを収集
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  // PointerEvent でストロークを描画（マウスで斜め線）
  const canvasBounds = await page.evaluate(() => {
    const c = document.getElementById('canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });

  if (canvasBounds) {
    console.log('キャンバスサイズ:', JSON.stringify(canvasBounds));

    // stroke 1: 左上から右下へ斜め線
    const cx = canvasBounds.x + canvasBounds.width / 2;
    const cy = canvasBounds.y + canvasBounds.height / 2;

    await page.dispatchEvent('#canvas', 'pointerdown', {
      pointerType: 'mouse',
      clientX: cx - 200,
      clientY: cy - 100,
      pressure: 0.5,
      button: 0,
      buttons: 1,
    });

    // 30点のストロークを描く
    for (let i = 0; i <= 30; i++) {
      const t = i / 30;
      await page.dispatchEvent('#canvas', 'pointermove', {
        pointerType: 'mouse',
        clientX: cx - 200 + 400 * t,
        clientY: cy - 100 + 200 * t,
        pressure: 0.3 + 0.4 * Math.sin(Math.PI * t), // 筆圧変化
        button: 0,
        buttons: 1,
      });
      await new Promise(r => setTimeout(r, 16));
    }

    await page.dispatchEvent('#canvas', 'pointerup', {
      pointerType: 'mouse',
      clientX: cx + 200,
      clientY: cy + 100,
      pressure: 0,
      button: 0,
      buttons: 0,
    });

    await new Promise(r => setTimeout(r, 200));

    // stroke 2: S字カーブ
    await page.dispatchEvent('#canvas', 'pointerdown', {
      pointerType: 'mouse',
      clientX: cx - 300,
      clientY: cy + 150,
      pressure: 0.5,
      button: 0,
      buttons: 1,
    });

    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      await page.dispatchEvent('#canvas', 'pointermove', {
        pointerType: 'mouse',
        clientX: cx - 300 + 600 * t,
        clientY: cy + 150 + 80 * Math.sin(Math.PI * 2 * t),
        pressure: 0.2 + 0.6 * Math.abs(Math.sin(Math.PI * t * 2)),
        button: 0,
        buttons: 1,
      });
      await new Promise(r => setTimeout(r, 16));
    }

    await page.dispatchEvent('#canvas', 'pointerup', {
      pointerType: 'mouse',
      clientX: cx + 300,
      clientY: cy + 150,
      pressure: 0,
      button: 0,
      buttons: 0,
    });

    await new Promise(r => setTimeout(r, 500));

    // 描画後のスクリーンショット
    const shot2 = path.join(SHOT_DIR, '02-after-strokes.png');
    await page.screenshot({ path: shot2 });
    console.log('描画後スクリーンショット:', shot2);

    // FPS / Points の値を読む
    const perfData = await page.evaluate(() => ({
      fps: document.getElementById('fps')?.textContent,
      latency: document.getElementById('latency')?.textContent,
      points: document.getElementById('points')?.textContent,
    }));
    console.log('パフォーマンス:', JSON.stringify(perfData));

  } else {
    console.log('ERROR: キャンバス要素が見つかりません');
  }

  if (errors.length > 0) {
    console.log('\nコンソールエラー:');
    for (const e of errors) console.log(' ', e);
  } else {
    console.log('コンソールエラー: なし');
  }

} finally {
  if (app) {
    await new Promise(r => setTimeout(r, 1000));
    await app.close().catch(() => {});
  }
}
