/**
 * 描画パイプライン（レイヤー対応）
 *
 * 各レイヤーは独立した committed テクスチャを持つ。描画系メソッドは
 * アクティブレイヤーの committed（committedTexture ゲッター）を対象に動作する。
 * render() は全レイヤーをブレンドモードで合成して画面に出す。
 */

import type { Renderer } from '../core/renderer.js';
import type { StrokePoint, StrokeRecord } from '../pen/stroke.js';
import { alignBrushBbox4x } from './brush-bbox.js';
import { BrushRenderer, type BrushConfig } from './brush.js';
import { CompositeRenderer } from './composite.js';
import { DownsampleRenderer } from './downsample.js';
import { BlendRenderer, type BlendMode } from './blend-renderer.js';
import { TransformRenderer } from './transform.js';
import { FilterRenderer, type FilterType, type FilterParams } from './filter.js';
import { buildCurveLut, type CurvePoint } from '../color/curve.js';
import { rasterizePolygon, floodFillMask, maskBounds, invertMask } from '../selection/mask.js';
import type { PmxLayer, PmxEffectLayer } from '../pmx.js';

/** 効果レイヤーの既定パラメータ */
const DEFAULT_FILTER_PARAMS: FilterParams = {
  radius: 8, threshold: 1, intensity: 1, ev: 0,
  inLow: 0, inHigh: 1, gamma: 1, outLow: 0, outHigh: 1,
};
import { linearToDisplaySrgb, TONEMAP_IDS, DISPLAY_MODE_IDS, type TonemapId, type DisplayModeId } from '../color/display.js';

const BUFFER_FORMAT: GPUTextureFormat = 'rgba16float';

export interface LayerInfo {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  alphaLock: boolean;
  kind: 'paint' | 'effect';        // effect=非破壊エフェクト（下の合成結果に適用）
  filterType?: FilterType;         // kind==='effect' のみ
  source?: string;                 // effect の入力ソース: 'below'（下の全結果）or ペイントレイヤーID
}

interface LayerTex extends LayerInfo {
  committed: GPUTexture;           // paint の描画先（effect でも確保しておく＝不変条件維持）
  params?: FilterParams;           // effect のパラメータ
  curvePoints?: CurvePoint[];      // effect(curve) の制御点
}

let layerIdCounter = 0;

export class RenderPipeline {
  private renderer: Renderer;
  private brushRenderer: BrushRenderer;
  private compositeRenderer: CompositeRenderer;
  private downsampleRenderer: DownsampleRenderer;
  private blendRenderer: BlendRenderer;
  private transformRenderer: TransformRenderer;
  private filterRenderer: FilterRenderer;

  private brushBboxTexture: GPUTexture | null = null;
  private brushBboxSize: { w: number; h: number } = { w: 0, h: 0 };
  private isolatedTexture!: GPUTexture;
  // レイヤー合成用
  private displayA!: GPUTexture;
  private displayB!: GPUTexture;
  private activeComposite!: GPUTexture; // アクティブレイヤー committed + 現在ストローク
  private filterScratch!: GPUTexture;   // 効果（レイヤー入力）の処理結果一時バッファ

  private layers: LayerTex[] = [];
  private activeIndex = 0;

  private currentStroke: StrokePoint[] = [];
  private eraseMode = false;
  // 背景色（リニア・不透明）。null は透明（台紙が透ける）
  private backgroundColor: { r: number; g: number; b: number } | null = null;

  // 表示変換パラメータ（露出 EV / トーンマップ / 表示モード）。PNG 書き出しと共有
  private displayExposure = 1;
  private displayTonemap: TonemapId = 'pbrNeutral';
  private displayMode: DisplayModeId = 'transform';

  private canvasWidth = 0;
  private canvasHeight = 0;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.brushRenderer = new BrushRenderer(renderer.device);
    this.compositeRenderer = new CompositeRenderer(renderer.device);
    this.downsampleRenderer = new DownsampleRenderer(renderer.device);
    this.blendRenderer = new BlendRenderer(renderer.device);
    this.transformRenderer = new TransformRenderer(renderer.device);
    this.filterRenderer = new FilterRenderer(renderer.device);
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
    await this.transformRenderer.init(BUFFER_FORMAT);
    await this.filterRenderer.init(canvas.width, canvas.height);
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

    // brushBboxTexture はストロークごとにサイズが変わるため createTextures では確保しない。
    // drawToIsolated で必要に応じて (再)確保する。
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
    // 効果の入力ソースがレイヤー指定のとき、処理結果を一時保持する
    this.filterScratch = this.renderer.device.createTexture({
      size: [width, height], format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
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
      alphaLock: false,
      kind: 'paint',
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

  /** 合成下地を背景色（不透明・プリマルチプライド=straight, a=1）or 透明でクリア */
  private clearToBackground(texture: GPUTexture): void {
    const bg = this.backgroundColor;
    const clearValue = bg ? { r: bg.r, g: bg.g, b: bg.b, a: 1 } : { r: 0, g: 0, b: 0, a: 0 };
    const encoder = this.renderer.device.createCommandEncoder();
    encoder.beginRenderPass({
      colorAttachments: [{ view: texture.createView(), clearValue, loadOp: 'clear', storeOp: 'store' }],
    }).end();
    this.renderer.device.queue.submit([encoder.finish()]);
  }

  setBackgroundColor(color: { r: number; g: number; b: number } | null): void {
    this.backgroundColor = color;
  }

  /** 表示変換（ビュー露出=2^EV / トーンマップ / 表示モード）を設定 */
  setDisplayParams(exposure: number, tonemap: TonemapId, mode: DisplayModeId): void {
    this.displayExposure = exposure;
    this.displayTonemap = tonemap;
    this.displayMode = mode;
    this.compositeRenderer.setDisplayParams(exposure, TONEMAP_IDS.indexOf(tonemap), DISPLAY_MODE_IDS.indexOf(mode));
  }

  // --- 描画（アクティブレイヤー対象）---

  setCurrentStroke(points: StrokePoint[]): void {
    this.currentStroke = points;
  }

  commitStroke(points: StrokePoint[]): void {
    if (points.length > 0) {
      this.drawAlphaLock = this.layers[this.activeIndex].alphaLock;
      this.drawToIsolated(points);
      this.compositeRenderer.bake(this.isolatedTexture, this.committedTexture, this.eraseMode);
    }
    this.currentStroke = [];
  }

  // 次の drawToIsolated で適用するアルファロック（描画経路ごとに設定）
  private drawAlphaLock = false;

  private drawToIsolated(points: StrokePoint[]): void {
    const { device } = this.renderer;
    // アルファロックをブラシに反映（既存 committed.a でマスク）
    this.brushRenderer.updateConfig({ alphaLock: this.drawAlphaLock });

    // 仕様（docs/spec.md）: 4x サブピクセルバッファは「ブラシ範囲のみ」。
    // ストローク点列から 4x 座標系のバウンディングボックスを計算し、
    // そのサイズのテクスチャだけ確保・クリア・描画・ダウンサンプルする。
    const SCALE = 4;
    const cw4 = this.canvasWidth * SCALE;
    const ch4 = this.canvasHeight * SCALE;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      const x4 = p.x * SCALE;
      const y4 = p.y * SCALE;
      const r4 = p.size * SCALE; // size は半径（brush.wgsl の offset = ±size）
      minX = Math.min(minX, x4 - r4);
      minY = Math.min(minY, y4 - r4);
      maxX = Math.max(maxX, x4 + r4);
      maxY = Math.max(maxY, y4 + r4);
    }
    // 4x原点と終端を1xピクセル境界（4の倍数）へ外向きに揃える。
    // 幅だけを4の倍数にして原点に端数を残すと、4xサンプルと1x書込先の
    // 位相がずれ、ストローク位置によって輪郭品質が変わる。
    const aligned = alignBrushBbox4x(minX, minY, maxX, maxY, cw4, ch4, SCALE);
    minX = aligned.minX;
    minY = aligned.minY;
    const bboxW4 = aligned.width;
    const bboxH4 = aligned.height;

    // bbox 4x テクスチャを（サイズが変われば再）確保
    if (!this.brushBboxTexture || this.brushBboxSize.w !== bboxW4 || this.brushBboxSize.h !== bboxH4) {
      this.brushBboxTexture?.destroy();
      this.brushBboxTexture = device.createTexture({
        size: [bboxW4, bboxH4],
        format: BUFFER_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.brushBboxSize = { w: bboxW4, h: bboxH4 };
    }

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.brushBboxTexture!.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
    });
    this.brushRenderer.renderStroke(
      pass, points, this.committedTexture, SCALE,
      minX, minY, bboxW4, bboxH4,
    );
    pass.end();
    device.queue.submit([encoder.finish()]);

    // isolatedTexture は全キャンバスを合成元として参照されるため、bbox 外に
    // 前回ストロークが残っていると、Undo の再ベイク時などに残像まで再合成される。
    // 部分ダウンサンプルの前に全体を透明へ戻し、今回の bbox だけを書き込む。
    this.clearTextureContent(this.isolatedTexture);

    // ダウンサンプル: bbox 4x → isolatedTexture の 1x オフセット位置へ
    // 1x オフセット = bbox 原点(4x) / 4
    this.downsampleRenderer.downsample(this.brushBboxTexture!, this.isolatedTexture, minX / SCALE, minY / SCALE);
  }

  /**
   * 全レイヤーを下から合成して結果テクスチャを返す
   * @param includeLiveStroke true ならアクティブレイヤーに現在ストロークを重ねる
   */
  private compositeLayers(includeLiveStroke: boolean, endIndex = this.layers.length - 1, transparentBg = false): GPUTexture {
    const { device } = this.renderer;

    // アクティブレイヤー用のソース（現在ストロークを焼き込んだ一時テクスチャ）
    let activeSrc: GPUTexture | null = null;
    if (includeLiveStroke && this.currentStroke.length > 0) {
      this.drawAlphaLock = this.layers[this.activeIndex].alphaLock;
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

    // ping-pong 合成。acc を背景色（or 透明）にクリアして下から重ねる
    // 焼き込み等で背景を含めたくない場合は透明クリア
    if (transparentBg) this.clearTextureContent(this.displayA);
    else this.clearToBackground(this.displayA);
    let acc = this.displayA;
    let other = this.displayB;

    for (let i = 0; i <= endIndex; i++) {
      const layer = this.layers[i];
      if (!layer.visible || layer.opacity <= 0) continue;
      if (layer.kind === 'effect' && layer.filterType && layer.params) {
        if (layer.filterType === 'curve' && layer.curvePoints) {
          this.filterRenderer.setCurveLut(buildCurveLut(layer.curvePoints));
        }
        // 入力ソースが特定ペイントレイヤーなら、そのレイヤーを入力に処理し acc へ重ねる
        const srcLayer = (layer.source && layer.source !== 'below')
          ? this.layers.find(l => l.id === layer.source && l.kind === 'paint')
          : undefined;
        if (srcLayer) {
          this.filterRenderer.apply(layer.filterType, layer.params, srcLayer.committed, null, this.filterScratch, 1.0);
          this.blendRenderer.blend(acc, this.filterScratch, other, 'normal', layer.opacity);
        } else {
          // 下の合成結果(acc)に適用して other へ（効果不透明度=opacity）
          this.filterRenderer.apply(layer.filterType, layer.params, acc, null, other, layer.opacity);
        }
      } else {
        const src = (i === this.activeIndex && activeSrc) ? activeSrc : layer.committed;
        this.blendRenderer.blend(acc, src, other, layer.blendMode, layer.opacity);
      }
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
    return this.layers.map(({ id, name, visible, opacity, blendMode, alphaLock, kind, filterType }) =>
      ({ id, name, visible, opacity, blendMode, alphaLock, kind, filterType }));
  }

  setLayerAlphaLock(id: string, locked: boolean): void {
    const l = this.layers.find(l => l.id === id);
    if (l) l.alphaLock = locked;
  }

  // --- 効果（非破壊エフェクト）レイヤー ---

  private static readonly EFFECT_LABELS: Record<FilterType, string> = {
    blur: 'ぼかし', glow: 'グロー', sharpen: 'シャープ', exposure: '露出', levels: 'レベル', curve: 'トーンカーブ',
  };

  /** 効果レイヤーを追加（アクティブの上に挿入して選択） */
  addEffectLayer(type: FilterType): string {
    const layer: LayerTex = {
      id: `layer-${++layerIdCounter}`,
      name: `効果: ${RenderPipeline.EFFECT_LABELS[type]}`,
      visible: true,
      opacity: 1.0,
      blendMode: 'normal',
      alphaLock: false,
      kind: 'effect',
      filterType: type,
      source: 'below',
      params: { ...DEFAULT_FILTER_PARAMS },
      curvePoints: type === 'curve' ? [{ x: 0, y: 0 }, { x: 1, y: 1 }] : undefined,
      committed: this.makeLayerTexture(), // 不変条件維持のため確保（未使用）
    };
    this.layers.splice(this.activeIndex + 1, 0, layer);
    this.activeIndex += 1;
    return layer.id;
  }

  /** 効果レイヤーのパラメータを更新 */
  setEffectParams(id: string, params: Partial<FilterParams>): void {
    const l = this.layers.find(l => l.id === id);
    if (l && l.kind === 'effect' && l.params) l.params = { ...l.params, ...params };
  }

  /** 効果(curve)レイヤーの制御点を更新 */
  setEffectCurve(id: string, points: CurvePoint[]): void {
    const l = this.layers.find(l => l.id === id);
    if (l && l.kind === 'effect') l.curvePoints = points.map(p => ({ ...p }));
  }

  /** 効果レイヤーの入力ソースを更新（'below' or ペイントレイヤーID） */
  setEffectSource(id: string, source: string): void {
    const l = this.layers.find(l => l.id === id);
    if (l && l.kind === 'effect') l.source = source;
  }

  /** 効果レイヤーの情報取得（UIのパラメータ編集用） */
  getEffect(id: string): { filterType: FilterType; params: FilterParams; curvePoints?: CurvePoint[]; source: string } | null {
    const l = this.layers.find(l => l.id === id);
    if (l && l.kind === 'effect' && l.filterType && l.params) {
      return { filterType: l.filterType, params: l.params, curvePoints: l.curvePoints, source: l.source ?? 'below' };
    }
    return null;
  }

  /** アクティブレイヤーが効果かどうか */
  isActiveEffect(): boolean {
    return this.layers[this.activeIndex]?.kind === 'effect';
  }

  /**
   * Freeze: 効果と下の全レイヤーを1枚のペイントレイヤーに統合する。
   * [0..effect] を合成（透明下地）→ 焼き込み、その範囲を1枚に置換。上のレイヤーは保持。
   */
  freezeEffectWithBelow(effectId: string): void {
    const idx = this.layers.findIndex(l => l.id === effectId);
    if (idx < 0 || this.layers[idx].kind !== 'effect') return;
    const result = this.compositeLayers(false, idx, true); // 透明下地で [0..idx] を合成
    const baked = this.makeLayerTexture();
    const enc = this.renderer.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: result }, { texture: baked }, [this.canvasWidth, this.canvasHeight]);
    this.renderer.device.queue.submit([enc.finish()]);
    for (let i = 0; i <= idx; i++) this.layers[i].committed.destroy();
    const layer: LayerTex = {
      id: `layer-${++layerIdCounter}`, name: '統合レイヤー',
      visible: true, opacity: 1.0, blendMode: 'normal', alphaLock: false,
      kind: 'paint', committed: baked,
    };
    this.layers.splice(0, idx + 1, layer);
    this.activeIndex = 0;
  }

  /**
   * Freeze: 効果を直下のペイントレイヤーに焼き込み、効果レイヤーを除去する。
   * 直下がペイントでなければ「下を統合」にフォールバック。
   */
  freezeEffectToBelow(effectId: string): void {
    const idx = this.layers.findIndex(l => l.id === effectId);
    if (idx < 0 || this.layers[idx].kind !== 'effect') return;
    const below = this.layers[idx - 1];
    if (!below || below.kind !== 'paint') { this.freezeEffectWithBelow(effectId); return; }
    const eff = this.layers[idx];
    // 直下レイヤーの内容をコピーして入力にし、効果を適用して書き戻す
    const srcCopy = this.makeLayerTexture();
    const enc = this.renderer.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: below.committed }, { texture: srcCopy }, [this.canvasWidth, this.canvasHeight]);
    this.renderer.device.queue.submit([enc.finish()]);
    if (eff.filterType === 'curve' && eff.curvePoints) this.filterRenderer.setCurveLut(buildCurveLut(eff.curvePoints));
    this.filterRenderer.apply(eff.filterType!, eff.params!, srcCopy, null, below.committed, eff.opacity);
    srcCopy.destroy();
    this.layers[idx].committed.destroy();
    this.layers.splice(idx, 1);
    this.activeIndex = this.layers.findIndex(l => l.id === below.id);
  }

  /** 全レイヤーの積み順（id） — .pmx 保存用 */
  getStackOrder(): string[] {
    return this.layers.map(l => l.id);
  }

  /** 効果レイヤーの仕様一覧 — .pmx 保存用 */
  getEffectSpecs(): PmxEffectLayer[] {
    return this.layers.filter(l => l.kind === 'effect').map(l => ({
      id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
      blendMode: 'normal' as const, kind: 'effect' as const,
      filterType: l.filterType!, params: l.params!, curvePoints: l.curvePoints, source: l.source ?? 'below',
    }));
  }

  // --- 選択範囲（任意形状マスク）---
  private selectionMask: GPUTexture | null = null;
  // 選択マスクの実データ（tight w*h, 0 or 255）。move/transform と輪郭表示が参照する
  private selectionMaskData: Uint8Array | null = null;
  // 選択範囲の bounds（キャンバスピクセル座標）。beginMove/beginTransform が参照する
  private selectionBounds: { lx: number; ty: number; rx: number; by: number } | null = null;

  hasSelection(): boolean { return this.selectionMask !== null; }

  /** 選択マスクデータ（tight w*h coverage）を返す。輪郭オーバーレイ用 */
  getSelectionMaskData(): { data: Uint8Array; w: number; h: number } | null {
    if (!this.selectionMaskData) return null;
    return { data: this.selectionMaskData, w: this.canvasWidth, h: this.canvasHeight };
  }

  /**
   * tight な coverage マスク（w*h, 0..255）を受け取り、bounds を算出して
   * GPU テクスチャへアップロードする。空マスクなら選択解除する。
   */
  private applySelectionMask(data: Uint8Array): void {
    const w = this.canvasWidth, h = this.canvasHeight;
    const bounds = maskBounds(data, w, h);
    if (!bounds) { this.clearSelection(); return; }

    if (!this.selectionMask) {
      this.selectionMask = this.renderer.device.createTexture({
        size: [w, h], format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    }
    // r8 は bytesPerRow 256 アラインが必要
    const bpr = Math.ceil(w / 256) * 256;
    const aligned = new Uint8Array(bpr * h);
    for (let y = 0; y < h; y++) aligned.set(data.subarray(y * w, y * w + w), y * bpr);
    this.renderer.device.queue.writeTexture(
      { texture: this.selectionMask },
      aligned, { bytesPerRow: bpr, rowsPerImage: h }, [w, h],
    );
    this.brushRenderer.setSelectionTexture(this.selectionMask);
    this.selectionMaskData = data;
    this.selectionBounds = bounds;
  }

  /** 矩形選択（キャンバス座標） */
  setRectSelection(x0: number, y0: number, x1: number, y1: number): void {
    const w = this.canvasWidth, h = this.canvasHeight;
    const lx = Math.max(0, Math.min(w, Math.round(Math.min(x0, x1))));
    const rx = Math.max(0, Math.min(w, Math.round(Math.max(x0, x1))));
    const ty = Math.max(0, Math.min(h, Math.round(Math.min(y0, y1))));
    const by = Math.max(0, Math.min(h, Math.round(Math.max(y0, y1))));
    if (rx - lx < 1 || by - ty < 1) { this.clearSelection(); return; }
    const data = new Uint8Array(w * h);
    for (let y = ty; y < by; y++) data.fill(255, y * w + lx, y * w + rx);
    this.applySelectionMask(data);
  }

  /** 投げ縄選択（キャンバス座標の多角形）。even-odd 走査線でラスタライズ */
  setLassoSelection(points: { x: number; y: number }[]): void {
    this.applySelectionMask(rasterizePolygon(points, this.canvasWidth, this.canvasHeight));
  }

  /** 自動選択（committed の連結同色領域）。tolerance: 0..1（straight color 差） */
  async setMagicWandSelection(x: number, y: number, tolerance: number): Promise<void> {
    const w = this.canvasWidth, h = this.canvasHeight;
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || ix >= w || iy < 0 || iy >= h) return;
    const snap = await this.requestCommittedSnapshot();
    const u16pr = snap.bytesPerRow / 2;
    // committed はプリマルチプライド float16。straight 色に戻してサンプリングする
    const sample = (px: number, py: number) => {
      const idx = py * u16pr + px * 4;
      const a = float16ToFloat32(snap.data[idx + 3]);
      const inv = a > 0.0001 ? 1 / a : 0;
      return {
        r: float16ToFloat32(snap.data[idx]) * inv,
        g: float16ToFloat32(snap.data[idx + 1]) * inv,
        b: float16ToFloat32(snap.data[idx + 2]) * inv,
        a,
      };
    };
    this.applySelectionMask(floodFillMask(w, h, ix, iy, sample, tolerance));
  }

  /** 選択範囲を反転（未選択なら全選択になる） */
  invertSelection(): void {
    this.applySelectionMask(invertMask(this.selectionMaskData, this.canvasWidth, this.canvasHeight));
  }

  clearSelection(): void {
    if (this.selectionMask) { this.selectionMask.destroy(); this.selectionMask = null; }
    this.brushRenderer.setSelectionTexture(null);
    this.selectionMaskData = null;
    this.selectionBounds = null;
  }

  // --- 変形ツール ---
  private txActive = false;
  private txSnapshot: Uint16Array | null = null;   // Undo 用（移動前全体）
  private txSrcTexture: GPUTexture | null = null;   // 切り出したコンテンツ
  private txBaseTexture: GPUTexture | null = null;  // 穴あき版
  private txBounds: { lx: number; ty: number; rx: number; by: number } | null = null;

  isTransformActive(): boolean { return this.txActive; }

  /**
   * 変形開始: コンテンツを切り出し、穴あき版を committed に書き込む。
   * bounds（bounds のキャンバス座標）を返す。
   */
  async beginTransform(): Promise<{ lx: number; ty: number; rx: number; by: number } | null> {
    if (this.txActive) return null;

    const snap = await this.requestCommittedSnapshot();
    this.txSnapshot = snap.data.slice(0);
    const w = this.canvasWidth, h = this.canvasHeight;
    const u16pr = snap.bytesPerRow / 2;

    let lx = 0, ty = 0, rx = w, by = h;
    if (this.selectionBounds) ({ lx, ty, rx, by } = this.selectionBounds);
    const cw = rx - lx, ch = by - ty;
    if (cw < 1 || ch < 1) return null;

    const mask = this.selectionMaskData; // null = 全選択（bounds = 全体）

    // base: committed を tight にコピー。src: 切り出すコンテンツ（選択外は 0）。
    // 選択ピクセルは base から抜く（穴あき化）。
    const baseTight = new Uint16Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const srow = y * u16pr;
      const drow = y * w * 4;
      for (let x = 0; x < w; x++) {
        const si = srow + x * 4, di = drow + x * 4;
        baseTight[di] = snap.data[si]; baseTight[di + 1] = snap.data[si + 1];
        baseTight[di + 2] = snap.data[si + 2]; baseTight[di + 3] = snap.data[si + 3];
      }
    }
    const srcTight = new Uint16Array(cw * ch * 4);
    for (let ry = 0; ry < ch; ry++) {
      const sy = ty + ry;
      for (let rxi = 0; rxi < cw; rxi++) {
        const sx = lx + rxi;
        if (mask && mask[sy * w + sx] === 0) continue;
        const si = sy * u16pr + sx * 4;
        const ci = (ry * cw + rxi) * 4;
        srcTight[ci] = snap.data[si]; srcTight[ci + 1] = snap.data[si + 1];
        srcTight[ci + 2] = snap.data[si + 2]; srcTight[ci + 3] = snap.data[si + 3];
        const bi = (sy * w + sx) * 4;
        baseTight[bi] = 0; baseTight[bi + 1] = 0; baseTight[bi + 2] = 0; baseTight[bi + 3] = 0;
      }
    }

    this.txSrcTexture = this.renderer.device.createTexture({
      size: [cw, ch], format: BUFFER_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.renderer.device.queue.writeTexture(
      { texture: this.txSrcTexture },
      srcTight as unknown as BufferSource,
      { bytesPerRow: cw * 8, rowsPerImage: ch }, [cw, ch],
    );

    this.txBaseTexture = this.renderer.device.createTexture({
      size: [w, h], format: BUFFER_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.renderer.device.queue.writeTexture(
      { texture: this.txBaseTexture },
      baseTight as unknown as BufferSource,
      { bytesPerRow: w * 8, rowsPerImage: h }, [w, h],
    );

    this.txBounds = { lx, ty, rx, by };
    this.txActive = true;
    return { lx, ty, rx, by };
  }

  /**
   * 変形を適用して committed を更新（ドラッグ中の毎フレーム呼ぶ）。
   * invMatrix: row-major 3x3 を array<vec4f,3> 形式の 12 floats で渡す。
   */
  updateTransform(invMatrix: Float32Array): void {
    if (!this.txActive || !this.txSrcTexture || !this.txBaseTexture || !this.txBounds) return;
    const { lx, ty, rx, by } = this.txBounds;
    this.transformRenderer.render(
      this.txSrcTexture,
      this.txBaseTexture,
      this.committedTexture,
      invMatrix,
      rx - lx, by - ty,
      this.canvasWidth, this.canvasHeight,
    );
  }

  /** 変形確定。Undo 用スナップショットを返す */
  commitTransform(): { snapshot: Uint16Array; bytesPerRow: number } | null {
    if (!this.txActive || !this.txSnapshot) return null;
    const snapshot = this.txSnapshot;
    const bytesPerRow = Math.ceil(this.canvasWidth * 8 / 256) * 256;
    this._clearTransformState();
    return { snapshot, bytesPerRow };
  }

  /** 変形キャンセル: committed を元の状態に戻す */
  cancelTransform(): void {
    if (!this.txActive || !this.txSnapshot) return;
    this.updateCommittedTexture(this.txSnapshot);
    this._clearTransformState();
  }

  private _clearTransformState(): void {
    this.txActive = false;
    this.txSnapshot = null;
    this.txSrcTexture?.destroy(); this.txSrcTexture = null;
    this.txBaseTexture?.destroy(); this.txBaseTexture = null;
    this.txBounds = null;
  }

  // --- フィルター（破壊的適用＋Undo・選択範囲対応）---
  private filterActive = false;
  private filterSnapshot: Uint16Array | null = null; // Undo 用（aligned）
  private filterSrc: GPUTexture | null = null;        // 原本コピー（入力）

  isFilterActive(): boolean { return this.filterActive; }

  /** フィルター開始: committed のスナップショット(Undo)と原本コピーを用意 */
  async beginFilter(): Promise<boolean> {
    if (this.filterActive) return false;
    const snap = await this.requestCommittedSnapshot();
    this.filterSnapshot = snap.data.slice(0);
    this.filterSrc?.destroy();
    this.filterSrc = this.renderer.device.createTexture({
      size: [this.canvasWidth, this.canvasHeight], format: BUFFER_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const enc = this.renderer.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: this.committedTexture }, { texture: this.filterSrc }, [this.canvasWidth, this.canvasHeight]);
    this.renderer.device.queue.submit([enc.finish()]);
    this.filterActive = true;
    return true;
  }

  /** トーンカーブ LUT を設定（main 側でカーブ編集時に呼ぶ） */
  setCurveLut(data: Uint8Array): void {
    this.filterRenderer.setCurveLut(data);
  }

  /** プレビュー更新: 原本にフィルターを適用し committed に書く（選択範囲があればその内側のみ） */
  updateFilter(type: FilterType, params: FilterParams): void {
    if (!this.filterActive || !this.filterSrc) return;
    this.filterRenderer.apply(type, params, this.filterSrc, this.selectionMask, this.committedTexture);
  }

  /** 確定: プレビュー結果を committed に残したまま状態をクリア（Undo 記録は呼び出し側） */
  commitFilter(): void {
    this._clearFilterState();
  }

  /** キャンセル: committed を元へ戻す */
  cancelFilter(): void {
    if (!this.filterActive || !this.filterSnapshot) return;
    this.updateCommittedTexture(this.filterSnapshot);
    this._clearFilterState();
  }

  private _clearFilterState(): void {
    this.filterActive = false;
    this.filterSnapshot = null;
    this.filterSrc?.destroy();
    this.filterSrc = null;
  }

  // --- 移動ツール ---
  private moveActive = false;
  // 移動前スナップショット（Undo 用）aligned Uint16Array
  private moveSnapshot: Uint16Array | null = null;
  // 穴あき版（コンテンツを除いた aligned Uint16Array）
  private moveBase: Uint16Array | null = null;
  // 切り出したコンテンツ（tight packed u16: cw*ch*4）+ 形状マスク（tight cw*ch）と元位置
  private moveContent: { data: Uint16Array; mask: Uint8Array; x: number; y: number; w: number; h: number } | null = null;
  // 選択マスクが矩形全体（穴なし）なら高速な行一括コピーが使える
  private moveMaskFull = false;
  // applyMoveOffset で使い回すバッファ
  private moveResult: Uint16Array | null = null;

  isMoveActive(): boolean { return this.moveActive; }

  /** 移動開始: アクティブレイヤーの対象領域を切り出し、穴あき版を committed に書き込む */
  async beginMove(): Promise<void> {
    if (this.moveActive) return;
    const snap = await this.requestCommittedSnapshot();
    const w = this.canvasWidth, h = this.canvasHeight;
    const u16pr = snap.bytesPerRow / 2;

    this.moveSnapshot = snap.data.slice(0);

    // 移動対象の bounds（選択範囲があればその範囲、なければ全体）
    let lx = 0, ty = 0, rx = w, by = h;
    if (this.selectionBounds) {
      ({ lx, ty, rx, by } = this.selectionBounds);
    }
    const cw = rx - lx, ch = by - ty;

    const mask = this.selectionMaskData; // null = 全選択（bounds 全体）
    // コンテンツ（選択ピクセルのみ・他は 0）と形状マスクを切り出し、base から抜く
    const content = new Uint16Array(cw * ch * 4);
    const moveMask = new Uint8Array(cw * ch);
    const base = snap.data.slice(0);
    let maskFull = true;
    for (let ry = 0; ry < ch; ry++) {
      const sy = ty + ry;
      for (let rxi = 0; rxi < cw; rxi++) {
        const sx = lx + rxi;
        if (mask && mask[sy * w + sx] === 0) { maskFull = false; continue; }
        const si = sy * u16pr + sx * 4;
        const ci = (ry * cw + rxi) * 4;
        content[ci] = base[si]; content[ci + 1] = base[si + 1];
        content[ci + 2] = base[si + 2]; content[ci + 3] = base[si + 3];
        moveMask[ry * cw + rxi] = 255;
        base[si] = 0; base[si + 1] = 0; base[si + 2] = 0; base[si + 3] = 0;
      }
    }
    this.moveContent = { data: content, mask: moveMask, x: lx, y: ty, w: cw, h: ch };
    this.moveMaskFull = maskFull;
    this.moveBase = base;
    this.moveResult = new Uint16Array(base.length);

    this.updateCommittedTexture(base);
    this.moveActive = true;
  }

  /**
   * ドラッグ中のオフセット適用（穴あき版 + コンテンツをオフセット位置に合成）。
   * キャンバス外にはみ出た部分はクリップする。
   */
  applyMoveOffset(dx: number, dy: number): void {
    if (!this.moveActive || !this.moveBase || !this.moveContent || !this.moveResult) return;
    const w = this.canvasWidth, h = this.canvasHeight;
    const u16pr = Math.ceil(w * 8 / 256) * 256 / 2;
    const { data: cnt, mask, x: cx, y: cy, w: cw, h: ch } = this.moveContent;
    const ndx = Math.round(dx), ndy = Math.round(dy);

    // 穴あき版をベースにコピー
    this.moveResult.set(this.moveBase);

    for (let ry = 0; ry < ch; ry++) {
      const wy = cy + ry + ndy;
      if (wy < 0 || wy >= h) continue;
      const wx0 = cx + ndx;
      const srcOff = ry * cw * 4;

      if (this.moveMaskFull && wx0 >= 0 && wx0 + cw <= w) {
        // 矩形選択かつ全列が範囲内 → TypedArray.set で行一括コピー（最速）
        this.moveResult.set(cnt.subarray(srcOff, srcOff + cw * 4), wy * u16pr + wx0 * 4);
      } else {
        // 形状マスク or 部分クリップ：選択ピクセルのみ書き込む
        const mrow = ry * cw;
        for (let rx2 = 0; rx2 < cw; rx2++) {
          if (mask[mrow + rx2] === 0) continue;
          const wx = wx0 + rx2;
          if (wx < 0 || wx >= w) continue;
          const si = srcOff + rx2 * 4;
          const di = wy * u16pr + wx * 4;
          this.moveResult[di] = cnt[si];
          this.moveResult[di + 1] = cnt[si + 1];
          this.moveResult[di + 2] = cnt[si + 2];
          this.moveResult[di + 3] = cnt[si + 3];
        }
      }
    }

    this.updateCommittedTexture(this.moveResult);
  }

  /**
   * 移動確定。Undo 用の移動前スナップショットと bytesPerRow を返す。
   */
  commitMove(): { snapshot: Uint16Array; bytesPerRow: number } | null {
    if (!this.moveActive || !this.moveSnapshot) return null;
    const snapshot = this.moveSnapshot;
    const bytesPerRow = Math.ceil(this.canvasWidth * 8 / 256) * 256;
    this.moveActive = false;
    this.moveSnapshot = null;
    this.moveBase = null;
    this.moveContent = null;
    this.moveResult = null;
    return { snapshot, bytesPerRow };
  }

  /** 移動キャンセル: committed を移動前の状態に戻す */
  cancelMove(): void {
    if (!this.moveActive || !this.moveSnapshot) return;
    this.updateCommittedTexture(this.moveSnapshot);
    this.moveActive = false;
    this.moveSnapshot = null;
    this.moveBase = null;
    this.moveContent = null;
    this.moveResult = null;
  }

  getActiveLayerAlphaLock(): boolean {
    return this.layers[this.activeIndex].alphaLock;
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
      if (layer.kind === 'effect') continue; // 効果レイヤーは現状 .pmx 非対応（次段で対応予定）
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
        info: { id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, blendMode: layer.blendMode, alphaLock: layer.alphaLock, kind: 'paint' },
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
      // 旧 .pmx には alphaLock/kind が無いので既定で補完
      return { ...info, alphaLock: info.alphaLock ?? false, kind: 'paint' as const, committed: tex };
    });
    if (this.layers.length === 0) this.layers = [this.createLayer('レイヤー 1')];
    const idx = this.layers.findIndex(l => l.id === activeId);
    this.activeIndex = idx >= 0 ? idx : 0;
  }

  /**
   * .pmx 読込（効果レイヤー対応）：ペイント＋効果を stackOrder の積み順で復元する。
   */
  loadDocument(width: number, height: number, paint: PmxLayer[], effects: PmxEffectLayer[], stackOrder: string[], activeId: string): void {
    this.resizeCanvasSize(width, height);
    for (const l of this.layers) l.committed.destroy();

    const byId = new Map<string, LayerTex>();
    for (const { info, data } of paint) {
      const tex = this.makeLayerTexture();
      this.writeLayerTight(tex, data);
      byId.set(info.id, { ...info, alphaLock: info.alphaLock ?? false, kind: 'paint', committed: tex });
    }
    for (const e of effects) {
      byId.set(e.id, {
        id: e.id, name: e.name, visible: e.visible, opacity: e.opacity,
        blendMode: 'normal', alphaLock: false, kind: 'effect',
        filterType: e.filterType, source: e.source ?? 'below', params: { ...e.params },
        curvePoints: e.curvePoints?.map(p => ({ ...p })),
        committed: this.makeLayerTexture(),
      });
    }

    const order = stackOrder.length ? stackOrder : [...byId.keys()];
    this.layers = order.map(id => byId.get(id)).filter((l): l is LayerTex => !!l);
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
    return this.readbackTexture(this.committedTexture);
  }

  /** 全レイヤー合成結果（リニア・プリマルチ）の CPU 読み出し（スポイト用） */
  async requestCompositeSnapshot() {
    return this.readbackTexture(this.compositeLayers(false));
  }

  private async readbackTexture(tex: GPUTexture) {
    const { device } = this.renderer;
    const width = this.canvasWidth;
    const height = this.canvasHeight;
    const bytesPerRow = Math.ceil(width * 8 / 256) * 256;
    const staging = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: staging, bytesPerRow }, [width, height]);
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
        // レコードに保存した alphaLock で再現（描画順は元と同じなのでマスクも一致）
        this.drawAlphaLock = rec.alphaLock ?? false;
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
    // リサイズ前に変形・移動・フィルター操作があればキャンセル
    if (this.txActive) this.cancelTransform();
    if (this.moveActive) this.cancelMove();
    if (this.filterActive) this.cancelFilter();
    this.brushRenderer.resize(w * 4, h * 4);
    this.brushBboxTexture?.destroy();
    this.brushBboxTexture = null;
    this.brushBboxSize = { w: 0, h: 0 };
    this.isolatedTexture.destroy();
    this.displayA.destroy(); this.displayB.destroy(); this.activeComposite.destroy();
    this.filterScratch.destroy();
    this.createTextures(w, h);
    this.filterRenderer.resize(w, h);
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
    // 画面表示と同じ変換で書き出す（WYSIWYG）。リニア生モードはトーンマップ無し(none)
    const exportTonemap = this.displayMode === 'raw' ? 'none' : this.displayTonemap;
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
          const disp = linearToDisplaySrgb([r / a, g / a, b / a], this.displayExposure, exportTonemap);
          imageData.data[pxIdx] = Math.round(disp[0] * 255);
          imageData.data[pxIdx + 1] = Math.round(disp[1] * 255);
          imageData.data[pxIdx + 2] = Math.round(disp[2] * 255);
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
    this.transformRenderer.dispose();
    this.filterRenderer.dispose();
    this._clearTransformState();
    this._clearFilterState();
    this.brushBboxTexture?.destroy();
    this.isolatedTexture?.destroy();
    this.displayA?.destroy(); this.displayB?.destroy(); this.activeComposite?.destroy();
    this.filterScratch?.destroy();
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
