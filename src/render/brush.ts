/**
 * ブラシ描画モジュール
 */

import type { StrokePoint } from '../pen/stroke.js';

export type BrushMixMode = 'stamp' | 'progressive';

export interface BrushConfig {
  color: { r: number; g: number; b: number; a: number };
  wetRatio: number;
  mixMode: BrushMixMode;
  usePointColor: boolean;
  useTexture: boolean;
  textureScale: number;
}

const DEFAULT_BRUSH_CONFIG: BrushConfig = {
  color: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
  wetRatio: 0.0,
  mixMode: 'stamp',
  usePointColor: false,
  useTexture: false,
  textureScale: 1.0,
};

export class BrushRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer;
  private pointBuffer: GPUBuffer;
  private sampler: GPUSampler;
  private brushSampler: GPUSampler;
  private bindGroup: GPUBindGroup | null = null;
  private bindGroupDirty = true;
  private config: BrushConfig;
  private shaderPath: string;
  private canvasSize = { width: 0, height: 0 };

  // テクスチャブラシ用
  private brushTexture: GPUTexture | null = null;
  private dummyTexture: GPUTexture;

  private readonly maxPoints = 500000;

  constructor(device: GPUDevice, config: Partial<BrushConfig> = {}, shaderPath = 'shaders/brush.wgsl') {
    this.device = device;
    this.config = { ...DEFAULT_BRUSH_CONFIG, ...config };
    this.shaderPath = shaderPath;

    this.uniformBuffer = device.createBuffer({
      size: 52, // テクスチャ関連パラメータ追加でサイズ増
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pointBuffer = device.createBuffer({
      size: this.maxPoints * 8 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.brushSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });

    // ダミーテクスチャ（テクスチャ未使用時）
    this.dummyTexture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // 白色1ピクセルを設定
    const white = new Uint8Array([255, 255, 255, 255]);
    device.queue.writeTexture({ texture: this.dummyTexture }, white, { bytesPerRow: 4 }, [1, 1]);
  }

  async init(canvasWidth: number, canvasHeight: number, format: GPUTextureFormat = 'rgba16float'): Promise<void> {
    this.canvasSize = { width: canvasWidth, height: canvasHeight };
    const response = await fetch(this.shaderPath);
    if (!response.ok) throw new Error(`Failed to load shader: ${this.shaderPath}`);
    const shaderModule = this.device.createShaderModule({ code: await response.text() });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: 'vertex_main' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fragment_main',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
          },
        }],
      },
      primitive: { topology: 'triangle-strip' },
    });

    this.updateUniforms(canvasWidth, canvasHeight);
    this.bindGroupDirty = true;
  }

  private updateUniforms(canvasWidth: number, canvasHeight: number): void {
    const buf = new ArrayBuffer(52); // テクスチャ関連でサイズ増
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    f32[0] = canvasWidth;
    f32[1] = canvasHeight;
    f32[2] = this.config.wetRatio;
    u32[3] = this.config.mixMode === 'stamp' ? 1 : 0;
    f32[4] = this.config.color.r;
    f32[5] = this.config.color.g;
    f32[6] = this.config.color.b;
    f32[7] = this.config.color.a;
    u32[8] = this.config.usePointColor ? 1 : 0;
    u32[9] = this.config.useTexture ? 1 : 0;
    f32[10] = this.config.textureScale;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, buf);
  }

  renderStroke(renderPass: GPURenderPassEncoder, points: StrokePoint[], committedTexture: GPUTexture, scale = 1.0): void {
    if (points.length === 0 || !this.pipeline) return;

    const c = this.config.color;
    const pointData = new Float32Array(points.length * 8);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const base = i * 8;
      pointData[base + 0] = p.x * scale;
      pointData[base + 1] = p.y * scale;
      pointData[base + 2] = p.size * scale;
      pointData[base + 3] = p.pressure;
      const col = p.color ?? c;
      pointData[base + 4] = col.r;
      pointData[base + 5] = col.g;
      pointData[base + 6] = col.b;
      pointData[base + 7] = col.a;
    }

    this.device.queue.writeBuffer(this.pointBuffer, 0, pointData);

    if (this.bindGroupDirty || !this.bindGroup || this.lastCommittedTexture !== committedTexture) {
      const textureToUse = this.brushTexture ?? this.dummyTexture;
      this.bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.pointBuffer } },
          { binding: 2, resource: committedTexture.createView() },
          { binding: 3, resource: this.sampler },
          { binding: 4, resource: textureToUse.createView() },
          { binding: 5, resource: this.brushSampler },
        ],
      });
      this.bindGroupDirty = false;
      this.lastCommittedTexture = committedTexture;
    }

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.draw(4, points.length, 0, 0);
  }

  private lastCommittedTexture: GPUTexture | null = null;

  updateConfig(config: Partial<BrushConfig>): void {
    this.config = { ...this.config, ...config };
    this.updateUniforms(this.canvasSize.width, this.canvasSize.height);
  }

  /**
   * テクスチャをロード
   * @param imageSource 画像ソース（ImageBitmapまたはHTMLImageElement）
   */
  async loadTexture(imageSource: ImageBitmap | HTMLImageElement): Promise<void> {
    // 既存のテクスチャを破棄
    if (this.brushTexture) {
      this.brushTexture.destroy();
      this.brushTexture = null;
    }

    const texture = this.device.createTexture({
      size: [imageSource.width, imageSource.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // ImageBitmap からテクスチャへコピー
    this.device.queue.copyExternalImageToTexture(
      { source: imageSource },
      { texture },
      [imageSource.width, imageSource.height]
    );

    this.brushTexture = texture;
    this.bindGroupDirty = true;
  }

  /**
   * テクスチャをクリア（円形ブラシに戻す）
   */
  clearTexture(): void {
    if (this.brushTexture) {
      this.brushTexture.destroy();
      this.brushTexture = null;
    }
    this.bindGroupDirty = true;
  }

  resize(canvasWidth: number, canvasHeight: number): void {
    this.canvasSize = { width: canvasWidth, height: canvasHeight };
    this.updateUniforms(canvasWidth, canvasHeight);
    this.bindGroupDirty = true;
  }

  dispose(): void {
    this.uniformBuffer.destroy();
    this.pointBuffer.destroy();
    if (this.brushTexture) this.brushTexture.destroy();
    this.dummyTexture.destroy();
  }
}
