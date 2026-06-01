/**
 * WebGPU レンダラー
 * レンダーループ、スワップチェーン管理
 */

import { initGPUDevice, GPUDeviceManager } from './device.js';

export interface Renderer {
  device: GPUDevice;
  format: GPUTextureFormat;
  context: GPUCanvasContext;
  canvas: HTMLCanvasElement;
}

/**
 * レンダラーを初期化
 */
export async function initRenderer(canvas: HTMLCanvasElement): Promise<Renderer> {
  const gpu = await initGPUDevice(canvas);
  const context = canvas.getContext('webgpu')!;

  return {
    device: gpu.device,
    format: gpu.format,
    context,
    canvas,
  };
}

/**
 * 現在のフレームのテクスチャビューを取得
 */
export function getCurrentTexture(renderer: Renderer): GPUTextureView {
  return renderer.context.getCurrentTexture().createView();
}

/**
 * レンダーループ用のユーティリティ
 */
export interface RenderLoop {
  start(callback: (timestamp: number) => void): void;
  stop(): void;
}

export function createRenderLoop(): RenderLoop {
  let running = true;
  let animationId: number | null = null;

  const callbackWrapper = (callback: (timestamp: number) => void) => {
    const frame = (timestamp: number) => {
      if (!running) return;
      callback(timestamp);
      animationId = requestAnimationFrame(frame);
    };
    animationId = requestAnimationFrame(frame);
  };

  return {
    start: (callback: (timestamp: number) => void) => {
      running = true;
      callbackWrapper(callback);
    },
    stop: () => {
      running = false;
      if (animationId !== null) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
    },
  };
}
