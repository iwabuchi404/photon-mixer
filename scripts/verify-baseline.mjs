/**
 * ベースライン起動検証スクリプト
 * Electron アプリを起動し、メインウィンドウの表示とコンソールエラーの有無を確認する
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

console.log('PhotonMixer ベースライン起動検証');
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

  // コンソールエラーを収集（ウィンドウ取得前から張る）
  const errors = [];

  await new Promise(r => setTimeout(r, 4000));
  let page = app.windows().find(w => !w.url().startsWith('devtools://'));
  if (!page) page = await app.firstWindow();

  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(String(err)));

  console.log('ウィンドウ URL:', page.url());
  console.log('ウィンドウ数:', app.windows().length);

  // タイトル・主要要素の存在確認
  const title = await page.title();
  console.log('ウィンドウタイトル:', title);

  const hasCanvas = await page.evaluate(() => !!document.getElementById('canvas'));
  console.log('canvas 要素:', hasCanvas ? '存在' : '不在');

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

  // 起動直後のスクリーンショットを少し待ってから撮る（描画安定待ち）
  await new Promise(r => setTimeout(r, 1000));
  const shotPath = path.join(SHOT_DIR, 'baseline-review.png');
  await page.screenshot({ path: shotPath });
  console.log('起動スクリーンショット:', shotPath);

  if (errors.length > 0) {
    console.log('\nコンソールエラー:');
    for (const e of errors) console.log(' ', e);
  } else {
    console.log('コンソールエラー: なし');
  }

} finally {
  if (app) {
    await new Promise(r => setTimeout(r, 500));
    await app.close().catch(() => {});
  }
}
