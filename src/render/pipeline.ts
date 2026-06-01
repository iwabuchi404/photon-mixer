/**
 * 描画パイプライン
 *
 * テクスチャ構成:
 *   brushTexture4x   4x 解像度でスタンプを描画（max blend でα蓄積なし）
 *   isolatedTexture  ダウンサンプル後の現在ストローク（1x）
 *   committedTexture 確定済みストロークの蓄積（ペンアップ時にベイク）
 *
 * レンダー順:
 *   brushTexture4x → downsample → isolatedTexture
 *   canvas = 背景 → committedTexture → isolatedTexture
 */

import type { Renderer } from '../core/renderer.js';
import type { StrokePoint } from '../pen/stroke.js';
import { BrushRenderer, type BrushConfig } from './brush.js';
import { CompositeRenderer } from './composite.js';
import { DownsampleRenderer } from './downsample.js';

const BUFFER_FORMAT: GPUTextureFormat = 'rgba16float';

export class RenderPipeline {
  private renderer: Renderer;
  private brushRenderer: BrushRenderer;
  private compositeRenderer: CompositeRenderer;
  private downsampleRenderer: DownsampleRenderer;

  // 4x 解像度のブラシ描画用テクスチャ
  private brushTexture4x!: GPUTexture;
  // 確定済みストロークを蓄積するテクスチャ
  private committedTexture!: GPUTexture;
  // 現在のストロークのみを描画するテクスチャ（1x, downsample先）
  private isolatedTexture!: GPUTexture;

  private currentStroke: StrokePoint[] = [];

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.brushRenderer = new BrushRenderer(renderer.device);
    this.compositeRenderer = new CompositeRenderer(renderer.device);
    this.downsampleRenderer = new DownsampleRenderer(renderer.device);
  }

  async init(): Promise<void> {
    const { canvas, format } = this.renderer;
    // 4x 解像度で初期化
    await this.brushRenderer.init(canvas.width * 4, canvas.height * 4, BUFFER_FORMAT);
    await this.compositeRenderer.init(format);
    await this.downsampleRenderer.init();

    this.createTextures(canvas.width, canvas.height);
  }

  private createTextures(width: number, height: number): void {
    this.brushTexture4x = this.renderer.device.createTexture({
      size: [width * 4, height * 4],
      format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.committedTexture = this.makeTexture(width, height);
    this.isolatedTexture = this.renderer.device.createTexture({
      size: [width, height],
      format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    // 新規テクスチャは内容が未定義のため透明でクリアする
    this.clearTextureContent(this.committedTexture);
    this.clearTextureContent(this.isolatedTexture);
  }

  private makeTexture(width: number, height: number): GPUTexture {
    return this.renderer.device.createTexture({
      size: [width, height],
      format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  /**
   * テクスチャを透明（0,0,0,0）でクリアする
   * WebGPU の新規テクスチャは内容が未定義のため、作成後に必ず呼ぶこと
   */
  private clearTextureContent(texture: GPUTexture): void {
    const encoder = this.renderer.device.createCommandEncoder();
    encoder.beginRenderPass({
      colorAttachments: [{
        view: texture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    }).end();
    this.renderer.device.queue.submit([encoder.finish()]);
  }

  setCurrentStroke(points: StrokePoint[]): void {
    this.currentStroke = points;
  }

  commitStroke(points: StrokePoint[]): void {
    if (points.length > 0) {
      // 最後に最新の状態で isolatedTexture に描画してからベイクする
      this.drawToIsolated(points);
      // 現在のストロークを確定済みテクスチャにベイク
      this.compositeRenderer.bake(this.isolatedTexture, this.committedTexture);
    }
    this.currentStroke = [];
  }

  /**
   * 指定された点列を 4x バッファに描画し、1x (isolated) にダウンサンプルする
   */
  private drawToIsolated(points: StrokePoint[]): void {
    const { device } = this.renderer;
    const encoder = device.createCommandEncoder();

    // Pass 1: brushTexture4x をクリアして 4x で描画
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.brushTexture4x.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      // 混色用に committedTexture を渡す
      this.brushRenderer.renderStroke(pass, points, this.committedTexture, 4.0);
      pass.end();
    }

    device.queue.submit([encoder.finish()]);

    // Step 2: 4x -> 1x ダウンサンプル
    this.downsampleRenderer.downsample(this.brushTexture4x, this.isolatedTexture);
  }

  render(): void {
    const { device, context } = this.renderer;

    // 現在描画中のストロークがあれば描画
    if (this.currentStroke.length > 0) {
      this.drawToIsolated(this.currentStroke);
    } else {
      // ストロークがない場合は isolated をクリアしておく（前回の残りを消す）
      const encoder = device.createCommandEncoder();
      encoder.beginRenderPass({
        colorAttachments: [{
          view: this.isolatedTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      }).end();
      device.queue.submit([encoder.finish()]);
    }

    // Pass 3: 背景色でクリアして committed と isolated を over blend で転写
    const finalEncoder = device.createCommandEncoder();
    {
      const pass = finalEncoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      // 1. 確定済みストロークを描画
      this.compositeRenderer.draw(pass, this.committedTexture);
      // 2. 現在のストローク（downsampled）を重ねる
      this.compositeRenderer.draw(pass, this.isolatedTexture);
      pass.end();
    }

    device.queue.submit([finalEncoder.finish()]);
  }

  updateBrushConfig(config: Partial<BrushConfig>): void {
    this.brushRenderer.updateConfig(config);
  }

  /**
   * committedTexture の内容を CPU に読み出す（引きずり混色用スナップショット）
   * pen-down 時に非同期で取得し、move イベントで色をサンプリングする
   */
  async requestCommittedSnapshot(): Promise<{ data: Uint16Array; bytesPerRow: number }> {
    const { device, canvas } = this.renderer;
    const { width, height } = canvas;
    // rgba16float: 8 bytes/pixel, bytesPerRow は 256 バイトアライン
    const bytesPerRow = Math.ceil(width * 8 / 256) * 256;

    const stagingBuffer = device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.committedTexture },
      { buffer: stagingBuffer, bytesPerRow },
      [width, height],
    );
    device.queue.submit([encoder.finish()]);

    await stagingBuffer.mapAsync(GPUMapMode.READ);
    // slice() でバッファを解放前にコピーする
    const data = new Uint16Array(stagingBuffer.getMappedRange().slice(0));
    stagingBuffer.unmap();
    stagingBuffer.destroy();

    return { data, bytesPerRow };
  }

  clear(): void {
    this.currentStroke = [];
    const { canvas } = this.renderer;
    this.committedTexture.destroy();
    this.committedTexture = this.makeTexture(canvas.width, canvas.height);
    // 新規テクスチャと残存ストロークを透明でクリア
    this.clearTextureContent(this.committedTexture);
    this.clearTextureContent(this.isolatedTexture);
  }

  resize(width: number, height: number): void {
    this.renderer.canvas.width = width;
    this.renderer.canvas.height = height;
    this.brushRenderer.resize(width * 4, height * 4);

    this.brushTexture4x.destroy();
    this.committedTexture.destroy();
    this.isolatedTexture.destroy();
    this.createTextures(width, height);
  }

  dispose(): void {
    this.brushRenderer.dispose();
    this.brushTexture4x?.destroy();
    this.committedTexture?.destroy();
    this.isolatedTexture?.destroy();
  }
}
