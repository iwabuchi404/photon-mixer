/**
 * WebGPU デバイス管理
 * アダプター取得、デバイス初期化、エラーハンドリング
 */

export interface GPUDeviceManager {
  device: GPUDevice;
  adapter: GPUAdapter;
  format: GPUTextureFormat;
}

/**
 * WebGPU デバイスを初期化
 */
export async function initGPUDevice(canvas: HTMLCanvasElement): Promise<GPUDeviceManager> {
  // WebGPUが利用可能か確認
  if (!navigator.gpu) {
    throw new Error('WebGPU is not supported in this browser');
  }

  // アダプター取得
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance', // パフォーマンス優先
  });

  if (!adapter) {
    throw new Error('Failed to get GPU adapter');
  }

  // デバイス取得
  const device = await adapter.requestDevice({
    requiredFeatures: ['float32-filterable'],
  });

  if (!device) {
    throw new Error('Failed to get GPU device');
  }

  // デバイスロス時のハンドリング
  device.lost.then((info) => {
    console.error('GPU device lost:', info.message);
    // 将来的に再初期化ロジックを追加
  });

  // WebGPU コンテキスト取得
  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('Failed to get WebGPU context');
  }

  // 推奨されるフォーマット（通常はRGBA8UnormまたはBGR8Unorm）
  const format = navigator.gpu.getPreferredCanvasFormat();

  // コンテキスト設定
  context.configure({
    device,
    format,
    alphaMode: 'premultiplied',
  });

  return { device, adapter, format };
}
