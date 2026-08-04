/**
 * 長時間使用・多レイヤー回帰:
 * - アイドル時に WebGPU submit が継続しない
 * - 通常レイヤー群を1回の blend submit にまとめる
 * - Undo上限を超えた描画がラスターチェックポイントとして残る
 */
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = path.join(appDir, 'node_modules/electron/dist/electron.exe');

async function pointer(page, type, x, y) {
  await page.dispatchEvent('#canvas', type, {
    pointerType: 'mouse', clientX: x, clientY: y,
    pressure: 0.8, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  });
}

async function stroke(page, x0, y0, x1, y1) {
  await pointer(page, 'pointerdown', x0, y0);
  await pointer(page, 'pointermove', (x0 + x1) / 2, (y0 + y1) / 2);
  await pointer(page, 'pointerup', x1, y1);
  await page.waitForTimeout(12);
}

let app;
try {
  app = await electron.launch({ executablePath: electronBin, args: [appDir], timeout: 30000, env: { ...process.env } });
  await new Promise(resolve => setTimeout(resolve, 3500));
  const page = app.windows().find(window => !window.url().startsWith('devtools://')) ?? await app.firstWindow();
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(`[${message.type()}] ${message.text()}`);
  });

  await page.evaluate(() => {
    document.getElementById('canvas-w').value = '800';
    document.getElementById('canvas-h').value = '600';
    document.getElementById('create-canvas-btn').click();
  });
  await page.waitForTimeout(500);

  await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const proto = Object.getPrototypeOf(device.queue);
    const original = proto.submit;
    const deviceProto = Object.getPrototypeOf(device);
    const originalCreateTexture = deviceProto.createTexture;
    window.__gpuSubmitCount = 0;
    window.__gpuTextureCreateCount = 0;
    proto.submit = function (...args) {
      window.__gpuSubmitCount++;
      return original.apply(this, args);
    };
    deviceProto.createTexture = function (...args) {
      window.__gpuTextureCreateCount++;
      return originalCreateTexture.apply(this, args);
    };
    device.destroy();
  });

  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__gpuSubmitCount = 0; });
  await page.waitForTimeout(750);
  const idleSubmits = await page.evaluate(() => window.__gpuSubmitCount);

  const box = await page.locator('#canvas').boundingBox();
  if (!box) throw new Error('canvas not found');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // 内容あり10レイヤーを作る。各レイヤーの短線は見分けやすく少しずらす。
  for (let i = 0; i < 10; i++) {
    await stroke(page, cx - 120, cy - 100 + i * 18, cx + 120, cy - 100 + i * 18);
    if (i < 9) await page.click('#layer-add');
  }
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__gpuSubmitCount = 0; window.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(500);
  const tenLayerRedrawSubmits = await page.evaluate(() => window.__gpuSubmitCount);

  // 空レイヤーを20枚追加しても合成パス数を増やさない。
  await page.evaluate(() => { window.__gpuTextureCreateCount = 0; });
  for (let i = 0; i < 20; i++) await page.click('#layer-add');
  const emptyLayerTextureCreates = await page.evaluate(() => window.__gpuTextureCreateCount);
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__gpuSubmitCount = 0; window.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(500);
  const withEmptyLayersRedrawSubmits = await page.evaluate(() => window.__gpuSubmitCount);
  await page.evaluate(() => { window.__gpuSubmitCount = 0; });
  await page.waitForTimeout(750);
  const manyLayerIdleSubmits = await page.evaluate(() => window.__gpuSubmitCount);

  // 55操作を積み、直近50操作だけUndoする。左側の最初の5本は基準画像として残る。
  for (let i = 0; i < 55; i++) {
    const row = i % 11;
    const col = Math.floor(i / 11);
    await stroke(page, cx - 210 + col * 18, cy + 100 + row * 8, cx - 198 + col * 18, cy + 100 + row * 8);
  }
  await page.screenshot({ path: path.join(appDir, 'screenshots', 'perf-history-before-undo.png') });
  for (let i = 0; i < 50; i++) {
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(8);
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(appDir, 'screenshots', 'perf-history-after-undo.png') });

  console.log(JSON.stringify({
    idleSubmits,
    tenLayerRedrawSubmits,
    withEmptyLayersRedrawSubmits,
    emptyLayerTextureCreates,
    manyLayerIdleSubmits,
    errors,
  }, null, 2));
} finally {
  if (app) await app.close().catch(() => {});
}
