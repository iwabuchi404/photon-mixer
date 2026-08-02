/**
 * 筆圧濃度の実行UI検証。
 * Electron 上で低筆圧・高筆圧の線を描き、表示明度に差が出ることを確認する。
 */

import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenshotBase = path.join(os.tmpdir(), `photon-pressure-${Date.now()}`);
const screenshotPaths = {
  low: `${screenshotBase}-low.png`,
  high: `${screenshotBase}-high.png`,
};
const errors = [];
const keepScreenshots = process.env.PM_KEEP_PRESSURE_SHOTS === '1';
let app;
let passed = false;

try {
  app = await electron.launch({
    executablePath: path.join(appDir, 'node_modules/electron/dist/electron.exe'),
    args: [appDir],
    timeout: 30_000,
    env: { ...process.env },
  });
  const page = await app.firstWindow();
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.waitForSelector('#tool-brush', { timeout: 15_000 });
  await page.waitForTimeout(3_500);
  const newCanvasModal = page.locator('#new-canvas-modal');
  if (await newCanvasModal.isVisible()) {
    await page.click('#create-canvas-btn');
    await newCanvasModal.waitFor({ state: 'hidden', timeout: 15_000 });
  }
  await page.waitForTimeout(500);

  const initial = await page.evaluate(() => {
    const row = document.querySelector('[data-param="pressureOpacity"]');
    const checkbox = document.getElementById('brush-pressure-opacity');
    return {
      rowVisible: !!row && getComputedStyle(row).display !== 'none',
      checked: checkbox instanceof HTMLInputElement ? checkbox.checked : null,
      gpu: !!navigator.gpu,
    };
  });

  await page.click('#tool-brush');
  await page.evaluate(() => {
    const setControl = (id, value, eventName = 'input') => {
      const element = document.getElementById(id);
      if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) {
        throw new Error(`missing control: ${id}`);
      }
      element.value = value;
      element.dispatchEvent(new Event(eventName, { bubbles: true }));
    };
    setControl('brush-size', '60');
    setControl('brush-stabilize', '0');
    setControl('brush-wet', '0');
    setControl('mix-mode', 'stamp', 'change');
    setControl('bg-color', '#000000');
  });
  if (!(await page.isChecked('#brush-pressure-opacity'))) {
    await page.click('#brush-pressure-opacity');
  }

  const bounds = await page.evaluate(() => {
    const rect = document.getElementById('canvas').getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      innerWidth,
      innerHeight,
    };
  });
  const x1 = bounds.x + bounds.width * 0.35;
  const x2 = bounds.x + bounds.width * 0.65;
  const strokeY = bounds.y + bounds.height * 0.52;

  async function drawStroke(y, pressure, pointerId) {
    const base = {
      pointerType: 'pen', pointerId, isPrimary: true,
      pressure, tiltX: 0, tiltY: 0, button: 0,
    };
    await page.dispatchEvent('#canvas', 'pointerdown', {
      ...base, clientX: x1, clientY: y, buttons: 1,
    });
    for (let i = 1; i <= 36; i++) {
      const t = i / 36;
      await page.dispatchEvent('#canvas', 'pointermove', {
        ...base, clientX: x1 + (x2 - x1) * t, clientY: y, buttons: 1,
      });
      await page.waitForTimeout(5);
    }
    await page.dispatchEvent('#canvas', 'pointerup', {
      ...base, clientX: x2, clientY: y, pressure: 0, buttons: 0,
    });
    await page.waitForTimeout(250);
  }

  // 初回の WebGPU パイプライン生成を計測対象から外す。
  await drawStroke(strokeY, 0.70, 20);
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('clear-btn')?.click());
  await page.waitForTimeout(250);

  await drawStroke(strokeY, 0.50, 21);
  await page.waitForTimeout(500);
  await page.screenshot({ path: screenshotPaths.low });
  await page.evaluate(() => document.getElementById('clear-btn')?.click());
  await page.waitForTimeout(250);
  await drawStroke(strokeY, 0.90, 22);
  await page.waitForTimeout(500);
  await page.screenshot({ path: screenshotPaths.high });

  const sample = await app.evaluate(({ nativeImage }, arg) => {
    const lineBrightness = (imagePath) => {
      const image = nativeImage.createFromPath(imagePath);
      const { width, height } = image.getSize();
      const bitmap = image.toBitmap();
      let brightest = 0;
      // 中央のキャンバス領域だけを走査し、パネルやパフォーマンス表示を除外する。
      for (let y = Math.round(height * 0.2); y < height * 0.8; y += 2) {
        for (let x = Math.round(width * 0.35); x < width * 0.65; x += 2) {
          const offset = (y * width + x) * 4;
          const value = (bitmap[offset] + bitmap[offset + 1] + bitmap[offset + 2]) / 3;
          brightest = Math.max(brightest, value);
        }
      }
      return brightest;
    };
    return {
      low: lineBrightness(arg.lowPath),
      high: lineBrightness(arg.highPath),
    };
  }, {
    lowPath: screenshotPaths.low,
    highPath: screenshotPaths.high,
  });

  const finalState = await page.evaluate(() => ({
    checked: document.getElementById('brush-pressure-opacity')?.checked,
    rowVisible: getComputedStyle(document.querySelector('[data-param="pressureOpacity"]')).display !== 'none',
    points: document.getElementById('points')?.textContent,
    fps: document.getElementById('fps')?.textContent,
  }));
  const contrast = sample.high - sample.low;
  console.log(JSON.stringify({ initial, bounds, finalState, sample, contrast, errors }, null, 2));

  if (!initial.rowVisible || !finalState.checked) {
    throw new Error('筆圧濃度コントロールが表示・有効化されていません');
  }
  if (contrast <= 20) {
    throw new Error(`低筆圧と高筆圧の明度差が不足しています: ${contrast}`);
  }
  if (errors.length > 0) {
    throw new Error(`描画中のエラー: ${errors.join(' | ')}`);
  }
  passed = true;
} finally {
  if (app) await app.close().catch(() => {});
  for (const screenshotPath of Object.values(screenshotPaths)) {
    if (passed && !keepScreenshots && fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
    if ((!passed || keepScreenshots) && fs.existsSync(screenshotPath)) console.error(`検証スクリーンショット: ${screenshotPath}`);
  }
}
