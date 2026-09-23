/**
 * WebGPU デバイス管理
 * アダプター取得、デバイス初期化、エラーハンドリング
 */

export interface GPUDeviceManager {
  device: GPUDevice;
  adapter: GPUAdapter;
  format: GPUTextureFormat;
  /** HDR出力が有効ならtrue（canvas = rgba16float + toneMapping extended） */
  hdr: boolean;
  /** extended canvas が受理されたか（実行時に standard⇄extended 切替可能） */
  hdrCapable: boolean;
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
  // 注意: float32-filterable は Safari 非対応のため要求しない。
  // float32 テクスチャのフィルタリングは未使用（全て rgba16float / rgba8unorm / r8unorm）。
  const device = await adapter.requestDevice({});

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
  let hdr = false;
  let hdrCapable = false;

  // HDR出力の試行: ディスプレイが HDR 対応（dynamic-range: high）か ?hdr=1 強制時。
  // extended が受理されたかは getConfiguration() で確認する（Chrome 131+）。
  // getConfiguration が無い環境では受理確認ができないため、SDR にフォールバックする。
  const hdrParam = new URLSearchParams(location.search).get('hdr');
  const hdrWanted =
    hdrParam === '1' || (hdrParam !== '0' && matchMedia('(dynamic-range: high)').matches);

  if (hdrWanted) {
    try {
      context.configure({
        device,
        format: 'rgba16float',
        alphaMode: 'premultiplied',
        colorSpace: 'srgb',
        toneMapping: { mode: 'extended' },
      });
      const configured = context.getConfiguration?.()?.toneMapping?.mode;
      // getConfiguration 非対応でも ?hdr=1 強制なら extended 受理とみなす
      if (configured === 'extended' || (configured === undefined && hdrParam === '1')) {
        hdr = true;
        hdrCapable = true;
      }
    } catch (e) {
      console.warn('HDR canvas configure failed, falling back to SDR:', e);
    }
  }

  if (!hdr) {
    // コンテキスト設定
    context.configure({
      device,
      format,
      alphaMode: 'premultiplied',
    });
  }

  return { device, adapter, format: hdrCapable ? 'rgba16float' : format, hdr, hdrCapable };
}
