/**
 * ブラシ描画モジュール
 * WebGPU Compute Shader によるスタンプ描画
 */

import type { StrokePoint } from '../pen/stroke.js';

/**
 * ブラシ描画の設定
 */
export interface BrushConfig {
  color: { r: number; g: number; b: number; a: number }; // リニア空間 0-1
}

/**
 * デフォルト設定（白、不透明度1.0）
 */
const DEFAULT_BRUSH_CONFIG: BrushConfig = {
  color: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
};

/**
 * ブラシレンダラー
 */
export class BrushRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer;
  private pointBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup | null = null;
  private bindGroupDirty = true; // BindGroup再作成フラグ
  private config: BrushConfig;
  private shaderPath: string; // シェーダーファイルのパス
  private canvasSize = { width: 0, height: 0 };

  private readonly maxPoints = 500000;

  constructor(
    device: GPUDevice,
    config: Partial<BrushConfig> = {},
    shaderPath = 'shaders/brush.wgsl', // デフォルトは開発環境パス
  ) {
    this.device = device;
    this.config = { ...DEFAULT_BRUSH_CONFIG, ...config };
    this.shaderPath = shaderPath;

    // Uniformバッファ作成（16 + 16 = 32 bytes）
    // canvas_width(4) + canvas_height(4) + padding(8) + brush_color(16)
    this.uniformBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 点バッファ作成（x, y, size, pressure）× maxPoints × 4bytes
    this.pointBuffer = device.createBuffer({
      size: this.maxPoints * 4 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * パイプラインを初期化
   */
  async init(canvasWidth: number, canvasHeight: number, format: GPUTextureFormat = 'bgra8unorm'): Promise<void> {
    this.canvasSize = { width: canvasWidth, height: canvasHeight };
    // シェーダーモジュールをロード（パスはコンストラクタで指定）
    const response = await fetch(this.shaderPath);
    if (!response.ok) {
      throw new Error(`Failed to load shader: ${this.shaderPath}`);
    }
    const shaderCode = await response.text();

    const shaderModule = this.device.createShaderModule({
      code: shaderCode,
    });

    // レンダーパイプライン作成
    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vertex_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fragment_main',
        targets: [
          {
            format,
            // プリマルチプライドαで max ブレンド
            // 同一ストローク内でスタンプが重なってもαが蓄積しない
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
              alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
            },
          },
        ],
      },
      primitive: {
        topology: 'triangle-strip',
      },
    });

    // Uniformバッファを更新
    this.updateUniforms(canvasWidth, canvasHeight);
    this.bindGroupDirty = true; // 初期化後にBindGroupを作成するようにマーク
  }

  /**
   * Uniformsを更新
   */
  private updateUniforms(canvasWidth: number, canvasHeight: number): void {
    const uniformData = new Float32Array([
      canvasWidth,
      canvasHeight,
      0, // padding
      0, // padding
      this.config.color.r,
      this.config.color.g,
      this.config.color.b,
      this.config.color.a,
    ]);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
  }

  /**
   * バインドグループを作成
   */
  private createBindGroup(): GPUBindGroup {
    if (!this.pipeline) {
      throw new Error('Pipeline not initialized');
    }

    return this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.pointBuffer } },
      ],
    });
  }

  /**
   * ストローク点を描画
   */
  renderStroke(
    renderPass: GPURenderPassEncoder,
    points: StrokePoint[],
    scale = 1.0,
  ): void {
    if (points.length === 0) return;

    // 最大点数チェック
    if (points.length > this.maxPoints) {
      console.warn(`Stroke has ${points.length} points, exceeding max ${this.maxPoints}. Truncating.`);
      // 超過分をトリミング（均等に間引く）
      const step = Math.ceil(points.length / this.maxPoints);
      const trimmedPoints: StrokePoint[] = [];
      for (let i = 0; i < points.length; i += step) {
        trimmedPoints.push(points[i]);
      }
      points = trimmedPoints;
    }

    // 点バッファにデータを書き込み
    const pointData = new Float32Array(points.length * 4);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      // 4x サブピクセルバッファ用に座標とサイズをスケール
      pointData[i * 4 + 0] = p.x * scale;
      pointData[i * 4 + 1] = p.y * scale;
      pointData[i * 4 + 2] = p.size * scale;
      pointData[i * 4 + 3] = p.pressure;
    }

    this.device.queue.writeBuffer(this.pointBuffer, 0, pointData);

    // バインドグループを作成（キャッシュ機構で効率化）
    if (this.bindGroupDirty || !this.bindGroup) {
      this.bindGroup = this.createBindGroup();
      this.bindGroupDirty = false;
    }

    renderPass.setPipeline(this.pipeline!);
    renderPass.setBindGroup(0, this.bindGroup);

    // 全点を一括 instanced draw（1点 = 4頂点の四角形）
    renderPass.draw(4, points.length, 0, 0);
  }

  /**
   * 設定を更新
   */
  updateConfig(config: Partial<BrushConfig>): void {
    this.config = { ...this.config, ...config };
    // uniform buffer を即時更新しないと色変更がGPUに反映されない
    this.updateUniforms(this.canvasSize.width, this.canvasSize.height);
  }

  /**
   * キャンバスサイズが変更されたとき
   */
  resize(canvasWidth: number, canvasHeight: number): void {
    this.canvasSize = { width: canvasWidth, height: canvasHeight };
    this.updateUniforms(canvasWidth, canvasHeight);
    this.bindGroupDirty = true;
  }

  /**
   * リソースを破棄
   */
  dispose(): void {
    this.uniformBuffer.destroy();
    this.pointBuffer.destroy();
  }
}
