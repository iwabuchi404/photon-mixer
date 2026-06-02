/**
 * 描画パイプライン（レイヤー対応）
 *
 * 各レイヤーは独立した committed テクスチャを持つ。描画系メソッドは
 * アクティブレイヤーの committed（committedTexture ゲッター）を対象に動作する。
 * render() は全レイヤーをブレンドモードで合成して画面に出す。
 */

import type { Renderer } from '../core/renderer.js';
import type { StrokePoint, StrokeRecord } from '../pen/stroke.js';
import { BrushRenderer, type BrushConfig } from './brush.js';
import { CompositeRenderer } from './composite.js';
import { DownsampleRenderer } from './downsample.js';
import { BlendRenderer, type BlendMode } from './blend-renderer.js';

const BUFFER_FORMAT: GPUTextureFormat = 'rgba16float';

export interface LayerInfo {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
}

interface LayerTex extends LayerInfo {
  committed: GPUTexture;
}

let layerIdCounter = 0;

export class RenderPipeline {
  private renderer: Renderer;
  private brushRenderer: BrushRenderer;
  private compositeRenderer: CompositeRenderer;
  private downsampleRenderer: DownsampleRenderer;
  private blendRenderer: BlendRenderer;

  private brushTexture4x!: GPUTexture;
  private isolatedTexture!: GPUTexture;
  // レイヤー合成用
  private displayA!: GPUTexture;
  private displayB!: GPUTexture;
  private activeComposite!: GPUTexture; // アクティブレイヤー committed + 現在ストローク

  private layers: LayerTex[] = [];
  private activeIndex = 0;

  private currentStroke: StrokePoint[] = [];
  private eraseMode = false;

  private canvasWidth = 0;
  private canvasHeight = 0;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.brushRenderer = new BrushRenderer(renderer.device);
    this.compositeRenderer = new CompositeRenderer(renderer.device);
    this.downsampleRenderer = new DownsampleRenderer(renderer.device);
    this.blendRenderer = new BlendRenderer(renderer.device);
  }

  // アクティブレイヤーの committed テクスチャ（既存の描画系メソッドが参照する）
  private get committedTexture(): GPUTexture {
    return this.layers[this.activeIndex].committed;
  }

  async init(): Promise<void> {
    const { canvas, format } = this.renderer;
    await this.brushRenderer.init(canvas.width * 4, canvas.height * 4, BUFFER_FORMAT);
    await this.compositeRenderer.init(format);
    await this.downsampleRenderer.init();
    await this.blendRenderer.init(BUFFER_FORMAT);
    this.createTextures(canvas.width, canvas.height);
    this.updateViewport(1.0, 0, 0, 0);
  }

  updateViewport(scale: number, offsetX: number, offsetY: number, rotation: number, flip = 1): void {
    this.compositeRenderer.updateViewport(
      scale, offsetX, offsetY, rotation,
      this.canvasWidth, this.canvasHeight,
      window.innerWidth, window.innerHeight,
      flip,
    );
  }

  setEraseMode(enabled: boolean): void {
    this.eraseMode = enabled;
  }

  // --- テクスチャ生成 ---

  private makeLayerTexture(): GPUTexture {
    const tex = this.renderer.device.createTexture({
      size: [this.canvasWidth, this.canvasHeight],
      format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
    this.clearTextureContent(tex);
    return tex;
  }

  private createTextures(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;

    this.brushTexture4x = this.renderer.device.createTexture({
      size: [width * 4, height * 4],
      format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.isolatedTexture = this.renderer.device.createTexture({
      size: [width, height],
      format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    const dispUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    this.displayA = this.renderer.device.createTexture({ size: [width, height], format: BUFFER_FORMAT, usage: dispUsage });
    this.displayB = this.renderer.device.createTexture({ size: [width, height], format: BUFFER_FORMAT, usage: dispUsage });
    this.activeComposite = this.renderer.device.createTexture({
      size: [width, height], format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // レイヤーを初期化（1枚）
    for (const l of this.layers) l.committed.destroy();
    this.layers = [this.createLayer('レイヤー 1')];
    this.activeIndex = 0;
  }

  private createLayer(name: string): LayerTex {
    return {
      id: `layer-${++layerIdCounter}`,
      name,
      visible: true,
      opacity: 1.0,
      blendMode: 'normal',
      committed: this.makeLayerTexture(),
    };
  }

  private clearTextureContent(texture: GPUTexture): void {
    const encoder = this.renderer.device.createCommandEncoder();
    encoder.beginRenderPass({
      colorAttachments: [{ view: texture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
    }).end();
    this.renderer.device.queue.submit([encoder.finish()]);
  }

  // --- 描画（アクティブレイヤー対象）---

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

  /**
   * 全レイヤーを下から合成して結果テクスチャを返す
   * @param includeLiveStroke true ならアクティブレイヤーに現在ストロークを重ねる
   */
  private compositeLayers(includeLiveStroke: boolean): GPUTexture {
    const { device } = this.renderer;

    // アクティブレイヤー用のソース（現在ストロークを焼き込んだ一時テクスチャ）
    let activeSrc: GPUTexture | null = null;
    if (includeLiveStroke && this.currentStroke.length > 0) {
      this.drawToIsolated(this.currentStroke);
      // active.committed をコピーしてから isolated を over/erase で重ねる
      const copyEnc = device.createCommandEncoder();
      copyEnc.copyTextureToTexture(
        { texture: this.committedTexture }, { texture: this.activeComposite },
        [this.canvasWidth, this.canvasHeight],
      );
      device.queue.submit([copyEnc.finish()]);
      this.compositeRenderer.bake(this.isolatedTexture, this.activeComposite, this.eraseMode);
      activeSrc = this.activeComposite;
    }

    // ping-pong 合成。acc を透明にクリアして下から重ねる
    this.clearTextureContent(this.displayA);
    let acc = this.displayA;
    let other = this.displayB;

    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      if (!layer.visible || layer.opacity <= 0) continue;
      const src = (i === this.activeIndex && activeSrc) ? activeSrc : layer.committed;
      this.blendRenderer.blend(acc, src, other, layer.blendMode, layer.opacity);
      const tmp = acc; acc = other; other = tmp;
    }
    return acc;
  }

  render(): void {
    const { device, context } = this.renderer;
    const result = this.compositeLayers(true);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 0.05, g: 0.05, b: 0.05, a: 1.0 }, loadOp: 'clear', storeOp: 'store' }],
    });
    this.compositeRenderer.drawPaper(pass);
    this.compositeRenderer.draw(pass, result);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  // --- レイヤー操作 ---

  getLayers(): LayerInfo[] {
    return this.layers.map(({ id, name, visible, opacity, blendMode }) => ({ id, name, visible, opacity, blendMode }));
  }

  getActiveLayerId(): string {
    return this.layers[this.activeIndex].id;
  }

  setActiveLayer(id: string): void {
    const idx = this.layers.findIndex(l => l.id === id);
    if (idx >= 0) this.activeIndex = idx;
  }

  addLayer(): string {
    const layer = this.createLayer(`レイヤー ${this.layers.length + 1}`);
    // アクティブレイヤーの上に挿入
    this.layers.splice(this.activeIndex + 1, 0, layer);
    this.activeIndex += 1;
    return layer.id;
  }

  removeActiveLayer(): void {
    if (this.layers.length <= 1) return; // 最低1枚は残す
    this.layers[this.activeIndex].committed.destroy();
    this.layers.splice(this.activeIndex, 1);
    if (this.activeIndex >= this.layers.length) this.activeIndex = this.layers.length - 1;
  }

  moveActiveLayer(dir: 'up' | 'down'): void {
    const to = dir === 'up' ? this.activeIndex + 1 : this.activeIndex - 1;
    if (to < 0 || to >= this.layers.length) return;
    const [l] = this.layers.splice(this.activeIndex, 1);
    this.layers.splice(to, 0, l);
    this.activeIndex = to;
  }

  setLayerVisible(id: string, visible: boolean): void {
    const l = this.layers.find(l => l.id === id);
    if (l) l.visible = visible;
  }

  getCanvasSize(): { width: number; height: number } {
    return { width: this.canvasWidth, height: this.canvasHeight };
  }

  /**
   * 全レイヤーのメタ情報とピクセルデータ（tight packed float16 RGBA）を読み出す
   * .pmx 保存用
   */
  async readAllLayers(): Promise<{ info: LayerInfo; data: Uint16Array }[]> {
    const { device } = this.renderer;
    const w = this.canvasWidth, h = this.canvasHeight;
    const bytesPerRow = Math.ceil(w * 8 / 256) * 256;
    const alignedU16 = bytesPerRow / 2;

    const out: { info: LayerInfo; data: Uint16Array }[] = [];
    for (const layer of this.layers) {
      const staging = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: layer.committed }, { buffer: staging, bytesPerRow }, [w, h]);
      device.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const aligned = new Uint16Array(staging.getMappedRange());
      // 256アライン → tight（width*4 u16/row）に詰め直す
      const tight = new Uint16Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        tight.set(aligned.subarray(y * alignedU16, y * alignedU16 + w * 4), y * w * 4);
      }
      staging.unmap(); staging.destroy();
      out.push({
        info: { id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, blendMode: layer.blendMode },
        data: tight,
      });
    }
    return out;
  }

  /**
   * .pmx 読込：キャンバスを作り直し、保存データから全レイヤーを復元する
   */
  loadLayers(width: number, height: number, layers: { info: LayerInfo; data: Uint16Array }[], activeId: string): void {
    // テクスチャ群をサイズ変更（レイヤーは createTextures で1枚に初期化される）
    this.resizeCanvasSize(width, height);
    // 既存レイヤー（初期1枚）を破棄して保存データで再構築
    for (const l of this.layers) l.committed.destroy();
    this.layers = layers.map(({ info, data }) => {
      const tex = this.makeLayerTexture();
      this.writeLayerTight(tex, data);
      return { ...info, committed: tex };
    });
    if (this.layers.length === 0) this.layers = [this.createLayer('レイヤー 1')];
    const idx = this.layers.findIndex(l => l.id === activeId);
    this.activeIndex = idx >= 0 ? idx : 0;
  }

  /** tight packed float16 データをテクスチャに書き込む */
  private writeLayerTight(tex: GPUTexture, data: Uint16Array): void {
    const { device } = this.renderer;
    const w = this.canvasWidth, h = this.canvasHeight;
    device.queue.writeTexture(
      { texture: tex },
      data as unknown as BufferSource,
      { bytesPerRow: w * 8, rowsPerImage: h }, // writeTexture は 256 アライン不要
      [w, h],
    );
  }

  setLayerOpacity(id: string, opacity: number): void {
    const l = this.layers.find(l => l.id === id);
    if (l) l.opacity = opacity;
  }

  setLayerBlendMode(id: string, mode: BlendMode): void {
    const l = this.layers.find(l => l.id === id);
    if (l) l.blendMode = mode;
  }

  // --- ブラシ・スナップショット系（アクティブレイヤー対象）---

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
   * 履歴レコードからアクティブレイヤーの committed を再構築（Undo/Redo 用）
   */
  rebakeFromRecords(records: StrokeRecord[]): void {
    this.clearTextureContent(this.committedTexture);
    this.brushRenderer.updateConfig({ usePointColor: true });
    for (const rec of records) {
      if (rec.kind === 'fill') {
        this.updateCommittedTexture(rec.snapshot);
      } else if (rec.points.length > 0) {
        this.drawToIsolated(rec.points);
        this.compositeRenderer.bake(this.isolatedTexture, this.committedTexture, rec.erase);
      }
    }
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

  /** アクティブレイヤーをクリア */
  clear() {
    this.currentStroke = [];
    this.clearTextureContent(this.committedTexture);
  }

  resizeCanvasSize(w: number, h: number) {
    this.brushRenderer.resize(w * 4, h * 4);
    this.brushTexture4x.destroy();
    this.isolatedTexture.destroy();
    this.displayA.destroy(); this.displayB.destroy(); this.activeComposite.destroy();
    this.createTextures(w, h);
  }

  resizeScreenSize(w: number, h: number) {
    this.renderer.canvas.width = w;
    this.renderer.canvas.height = h;
  }

  /**
   * 全レイヤーを合成した結果を PNG としてエクスポート
   */
  async exportToPNG(): Promise<Blob> {
    const { device } = this.renderer;
    const width = this.canvasWidth;
    const height = this.canvasHeight;
    const bytesPerRow = Math.ceil(width * 8 / 256) * 256;

    // 現在ストロークなしで全レイヤーを合成
    const result = this.compositeLayers(false);

    const staging = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: result }, { buffer: staging, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const uint16Data = new Uint16Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const ctx = tempCanvas.getContext('2d')!;
    const imageData = ctx.createImageData(width, height);

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
          imageData.data[pxIdx] = 0; imageData.data[pxIdx + 1] = 0;
          imageData.data[pxIdx + 2] = 0; imageData.data[pxIdx + 3] = 0;
        } else {
          imageData.data[pxIdx] = Math.round(linearToSrgbByte(r / a));
          imageData.data[pxIdx + 1] = Math.round(linearToSrgbByte(g / a));
          imageData.data[pxIdx + 2] = Math.round(linearToSrgbByte(b / a));
          imageData.data[pxIdx + 3] = Math.round(a * 255);
        }
      }
    }
    ctx.putImageData(imageData, 0, 0);
    return await new Promise<Blob>((resolve) => tempCanvas.toBlob((b) => resolve(b!), 'image/png'));
  }

  async loadBrushTexture(image: ImageBitmap | HTMLImageElement): Promise<void> {
    await this.brushRenderer.loadTexture(image);
  }

  clearBrushTexture(): void {
    this.brushRenderer.clearTexture();
  }

  dispose() {
    this.brushRenderer.dispose();
    this.brushTexture4x?.destroy();
    this.isolatedTexture?.destroy();
    this.displayA?.destroy(); this.displayB?.destroy(); this.activeComposite?.destroy();
    for (const l of this.layers) l.committed.destroy();
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
