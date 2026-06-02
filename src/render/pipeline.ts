/**
 * 描画パイプライン
 */

import type { Renderer } from '../core/renderer.js';
import type { StrokePoint, StrokeRecord } from '../pen/stroke.js';
import { BrushRenderer, type BrushConfig } from './brush.js';
import { CompositeRenderer } from './composite.js';
import { DownsampleRenderer } from './downsample.js';

const BUFFER_FORMAT: GPUTextureFormat = 'rgba16float';

export class RenderPipeline {
  private renderer: Renderer;
  private brushRenderer: BrushRenderer;
  private compositeRenderer: CompositeRenderer;
  private downsampleRenderer: DownsampleRenderer;

  private brushTexture4x!: GPUTexture;
  private committedTexture!: GPUTexture;
  private isolatedTexture!: GPUTexture;

  private currentStroke: StrokePoint[] = [];
  private eraseMode = false;

  // キャンバスサイズ（描画対象のサイズ）
  private canvasWidth = 0;
  private canvasHeight = 0;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.brushRenderer = new BrushRenderer(renderer.device);
    this.compositeRenderer = new CompositeRenderer(renderer.device);
    this.downsampleRenderer = new DownsampleRenderer(renderer.device);
  }

  async init(): Promise<void> {
    const { canvas, format } = this.renderer;
    await this.brushRenderer.init(canvas.width * 4, canvas.height * 4, BUFFER_FORMAT);
    await this.compositeRenderer.init(format);
    await this.downsampleRenderer.init();
    this.createTextures(canvas.width, canvas.height);
    this.updateViewport(1.0, 0, 0, 0);
  }

  updateViewport(scale: number, offsetX: number, offsetY: number, rotation: number): void {
    // 紙の四角形のサイズはアートキャンバスのサイズ（committed texture と一致）を渡す。
    // 画面サイズ（renderer.canvas）を渡すと toCanvas の中心と不一致になり座標がずれる。
    this.compositeRenderer.updateViewport(
      scale, offsetX, offsetY, rotation,
      this.canvasWidth, this.canvasHeight,
      window.innerWidth, window.innerHeight,
    );
  }

  setEraseMode(enabled: boolean): void {
    this.eraseMode = enabled;
  }

  private createTextures(width: number, height: number): void {
    // キャンバスサイズを保存
    this.canvasWidth = width;
    this.canvasHeight = height;

    this.brushTexture4x = this.renderer.device.createTexture({
      size: [width * 4, height * 4],
      format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.committedTexture = this.renderer.device.createTexture({
      size: [width, height],
      format: BUFFER_FORMAT,
      // COPY_SRC: スナップショット読み出し / COPY_DST: バケツ塗りの書き戻し
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
    this.isolatedTexture = this.renderer.device.createTexture({
      size: [width, height],
      format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    this.clearTextureContent(this.committedTexture);
    this.clearTextureContent(this.isolatedTexture);
  }

  private clearTextureContent(texture: GPUTexture): void {
    const encoder = this.renderer.device.createCommandEncoder();
    encoder.beginRenderPass({
      colorAttachments: [{ view: texture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
    }).end();
    this.renderer.device.queue.submit([encoder.finish()]);
  }

  setCurrentStroke(points: StrokePoint[]): void {
    this.currentStroke = points;
  }

  commitStroke(points: StrokePoint[]): void {
    if (points.length > 0) {
      this.drawToIsolated(points);
      this.compositeRenderer.bake(this.isolatedTexture, this.committedTexture, this.eraseMode);
    }
    this.currentStroke = [];
  }

  private drawToIsolated(points: StrokePoint[]): void {
    const { device } = this.renderer;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.brushTexture4x.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
    });
    this.brushRenderer.renderStroke(pass, points, this.committedTexture, 4.0);
    pass.end();
    device.queue.submit([encoder.finish()]);
    this.downsampleRenderer.downsample(this.brushTexture4x, this.isolatedTexture);
  }

  render(): void {
    const { device, context } = this.renderer;
    if (this.currentStroke.length > 0) {
      this.drawToIsolated(this.currentStroke);
    } else {
      this.clearTextureContent(this.isolatedTexture);
    }

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 0.05, g: 0.05, b: 0.05, a: 1.0 }, loadOp: 'clear', storeOp: 'store' }],
    });
    this.compositeRenderer.drawPaper(pass);
    this.compositeRenderer.draw(pass, this.committedTexture);
    this.compositeRenderer.draw(pass, this.isolatedTexture, this.eraseMode);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  // ... (その他のメソッド)
  updateBrushConfig(config: Partial<BrushConfig>): void { this.brushRenderer.updateConfig(config); }
  async requestCommittedSnapshot() {
    const { device } = this.renderer;
    const width = this.canvasWidth;
    const height = this.canvasHeight;
    const bytesPerRow = Math.ceil(width * 8 / 256) * 256;
    const staging = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.committedTexture }, { buffer: staging, bytesPerRow }, [width, height]);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const data = new Uint16Array(staging.getMappedRange().slice(0));
    staging.unmap(); staging.destroy();
    return { data, bytesPerRow };
  }
  /**
   * 履歴レコードから committedTexture を再構築する（Undo/Redo 用）
   * - stroke: 点に焼き込んだ色を使って描画（usePointColor=true）、erase フラグを尊重
   * - fill  : スナップショットで committed を上書き（それ以前の内容を吸収）
   */
  rebakeFromRecords(records: StrokeRecord[]): void {
    this.clearTextureContent(this.committedTexture);
    // 焼き込んだ色を忠実に再現するため点ごとの色モードで描く
    this.brushRenderer.updateConfig({ usePointColor: true });
    for (const rec of records) {
      if (rec.kind === 'fill') {
        this.updateCommittedTexture(rec.snapshot);
      } else if (rec.points.length > 0) {
        this.drawToIsolated(rec.points);
        this.compositeRenderer.bake(this.isolatedTexture, this.committedTexture, rec.erase);
      }
    }
    // ライブ描画はデフォルト（uniform 色）に戻す。progressive は pen-down で再設定される
    this.brushRenderer.updateConfig({ usePointColor: false });
  }
  updateCommittedTexture(data: Uint16Array): void {
    const { device } = this.renderer;
    const width = this.canvasWidth;
    const height = this.canvasHeight;
    const bytesPerRow = Math.ceil(width * 8 / 256) * 256;
    device.queue.writeTexture(
      { texture: this.committedTexture },
      data as unknown as BufferSource,
      { bytesPerRow, rowsPerImage: height },
      [width, height]
    );
  }
  clear() {
    this.currentStroke = [];
    this.clearTextureContent(this.committedTexture);
    this.clearTextureContent(this.isolatedTexture);
  }

  /**
   * キャンバスサイズを変更（canvas.width/height は変更しない）
   */
  resizeCanvasSize(w: number, h: number) {
    this.brushRenderer.resize(w * 4, h * 4);
    this.brushTexture4x.destroy(); this.committedTexture.destroy(); this.isolatedTexture.destroy();
    this.createTextures(w, h);
  }

  /**
   * スクリーンサイズを変更（canvas.width/height のみ変更）
   */
  resizeScreenSize(w: number, h: number) {
    this.renderer.canvas.width = w;
    this.renderer.canvas.height = h;
  }

  /**
   * コミット済テクスチャを PNG としてエクスポート
   * float16 リニアデータを読み取り、sRGB 変換して Canvas 経由で PNG に変換
   */
  async exportToPNG(): Promise<Blob> {
    const { device } = this.renderer;
    const width = this.canvasWidth;
    const height = this.canvasHeight;
    const bytesPerRow = Math.ceil(width * 8 / 256) * 256;

    // テクスチャからバッファにコピー
    const staging = device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.committedTexture },
      { buffer: staging, bytesPerRow },
      [width, height]
    );
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const uint16Data = new Uint16Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();

    // 一時 Canvas に描画して sRGB PNG を生成
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const ctx = tempCanvas.getContext('2d')!;
    const imageData = ctx.createImageData(width, height);

    // Float16 → sRGB 変換
    const uint16sPerRow = bytesPerRow / 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * uint16sPerRow + x * 4;
        const r = float16ToFloat32(uint16Data[idx]);
        const g = float16ToFloat32(uint16Data[idx + 1]);
        const b = float16ToFloat32(uint16Data[idx + 2]);
        const a = float16ToFloat32(uint16Data[idx + 3]);

        const pxIdx = (y * width + x) * 4;
        if (a < 0.0001) {
          imageData.data[pxIdx] = 0;
          imageData.data[pxIdx + 1] = 0;
          imageData.data[pxIdx + 2] = 0;
          imageData.data[pxIdx + 3] = 0;
        } else {
          // プリマルチプライドαを元に戻して sRGB 変換
          const straightR = r / a;
          const straightG = g / a;
          const straightB = b / a;
          imageData.data[pxIdx] = Math.round(linearToSrgbByte(straightR));
          imageData.data[pxIdx + 1] = Math.round(linearToSrgbByte(straightG));
          imageData.data[pxIdx + 2] = Math.round(linearToSrgbByte(straightB));
          imageData.data[pxIdx + 3] = Math.round(a * 255);
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);

    // Canvas を PNG Blob に変換
    const blob = await new Promise<Blob>((resolve) => {
      tempCanvas.toBlob((b) => resolve(b!), 'image/png');
    });

    return blob;
  }

  /**
   * ブラシテクスチャをロード
   */
  async loadBrushTexture(image: ImageBitmap | HTMLImageElement): Promise<void> {
    await this.brushRenderer.loadTexture(image);
  }

  /**
   * ブラシテクスチャをクリア
   */
  clearBrushTexture(): void {
    this.brushRenderer.clearTexture();
  }

  dispose() {
    this.brushRenderer.dispose();
    this.brushTexture4x?.destroy(); this.committedTexture?.destroy(); this.isolatedTexture?.destroy();
  }
}

// Float16 → Float32 変換
function float16ToFloat32(h: number): number {
  const sign = (h >> 15) & 1;
  const exp = (h >> 10) & 0x1F;
  const frac = h & 0x3FF;
  if (exp === 0) return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
  if (exp === 31) return frac === 0 ? (sign ? -Infinity : Infinity) : NaN;
  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

// リニア→sRGB 変換 (Byte)
function linearToSrgbByte(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  if (c <= 0.0031308) return c * 255 * 12.92;
  return (1.055 * Math.pow(c, 1.0 / 2.4) - 0.055) * 255;
}
