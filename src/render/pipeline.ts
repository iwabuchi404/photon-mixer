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
import { RibbonRenderer } from './ribbon.js';
import { CompositeRenderer } from './composite.js';
import { DownsampleRenderer } from './downsample.js';
import { BlendRenderer, type BlendMode, type TileBlendOp } from './blend-renderer.js';
import { TileBakeRenderer, type TileBakeMode } from './tile-bake.js';
import { TileStore, TILE_SIZE } from './tile-store.js';
import { TransformRenderer } from './transform.js';
import { FilterRenderer, type FilterType, type FilterParams } from './filter.js';
import { buildCurveLut, type CurvePoint } from '../color/curve.js';
import { rasterizePolygon, floodFillMask, maskBounds, invertMask } from '../selection/mask.js';
import {
  type LayerNode, type FolderNode, type CellNode, type EffectChainItem,
  findNode, findCell, findParent, flattenCells, visibleCells, findEffect,
  createCell, createFolder, createEffect, removeNode, moveNode,
} from './layer-model.js';
import { linearToDisplaySrgb, TONEMAP_IDS, DISPLAY_MODE_IDS, type TonemapId, type DisplayModeId } from '../color/display.js';

const BUFFER_FORMAT: GPUTextureFormat = 'rgba16float';
/** 変形・フィルター書き戻し時のタイル余裕（1タイル分）。過剰保持は上限40で有界 */
const TILE_MARGIN = 512;

// レイヤーモデルの型を再エクスポート（旧API互換用）
export type { LayerNode, FolderNode, CellNode, EffectChainItem } from './layer-model.js';

export class RenderPipeline {
  private renderer: Renderer;
  private brushRenderer: BrushRenderer;
  private ribbonRenderer: RibbonRenderer;
  /** true=リボン筆（メインブラシ）で描く。false=スタンプ（テクスチャブラシ等） */
  private ribbonMode = false;
  private compositeRenderer: CompositeRenderer;
  private downsampleRenderer: DownsampleRenderer;
  private blendRenderer: BlendRenderer;
  private transformRenderer: TransformRenderer;
  private filterRenderer: FilterRenderer;

  private brushBboxTexture: GPUTexture | null = null;
  private brushBboxSize: { w: number; h: number } = { w: 0, h: 0 };
  private isolatedTexture!: GPUTexture;
  private strokeAccumTexture!: GPUTexture; // 分割フラッシュ済みの「一筆」を max 合成で保持
  private liveCombinedTexture!: GPUTexture; // accumulator + 可変末尾のライブ表示用
  private hasStrokeAccum = false;
  /** 一筆 accumulator の内容 bbox（タイル書き戻し範囲用）。begin でリセット */
  private strokeAccumBBox: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  // T2: 2段キャッシュ。baseCache=層スタック結果、displayCache=撮影適用後。
  // compA/compB=再計算用 ping-pong scratch。blankTile=空タイル用下地（背景色）。
  private baseCache!: GPUTexture;
  private displayCache!: GPUTexture;
  private compA!: GPUTexture;
  private compB!: GPUTexture;
  private blankTile!: GPUTexture;
  // ダーティタイル集合（base/display別）。空集合＝キャッシュ有効
  private dirtyBase = new Set<number>();
  private dirtyDisplay = new Set<number>();
  private activeComposite!: GPUTexture; // アクティブレイヤー committed + 現在ストローク
  private filterScratch!: GPUTexture;   // 効果（レイヤー入力）の処理結果一時バッファ
  private cellProcTemp!: GPUTexture;    // セル効果チェーン処理用（ping-pong）

  // 3オブジェクト構造: レイヤーツリー + ルート効果チェーン（撮影スタック）
  private rootNodes: LayerNode[] = [];
  private rootEffects: EffectChainItem[] = [];
  private activeCellId: string | null = null;
  // T1: コミット済みセル内容の疎タイルストア。履歴基準は `h:<cellId>` owner で同居
  private tileStore!: TileStore;
  private tileBaker!: TileBakeRenderer;
  // タイル合成・サンプリング・readback 用の fullscreen scratch（共有。composedTag で正当性管理）
  private composeScratch!: GPUTexture;
  private composedTag: { owner: string; version: number } | null = null;
  // modal プレビュー（移動・変形）用の fullscreen 保持テクスチャ
  private previewTexture!: GPUTexture;
  private previewOverride: { cellId: string; texture: GPUTexture } | null = null;
  // 新規の空レイヤーを合成パスから除外するための保守的な内容フラグ。
  private nonEmptyCells: Set<string> = new Set();
  // 画面内容に変化がないフレームでは、全レイヤー合成と GPU submit を省く。
  private renderDirty = true;

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
    this.ribbonRenderer = new RibbonRenderer(renderer.device);
    this.compositeRenderer = new CompositeRenderer(renderer.device);
    this.downsampleRenderer = new DownsampleRenderer(renderer.device);
    this.blendRenderer = new BlendRenderer(renderer.device);
    this.tileBaker = new TileBakeRenderer(renderer.device);
    this.transformRenderer = new TransformRenderer(renderer.device);
    this.filterRenderer = new FilterRenderer(renderer.device);
  }

  /** 履歴基準の owner 名 */
  private static historyOwner(cellId: string): string {
    return `h:${cellId}`;
  }

  /** リボン筆モードの切替（ツール切替時に呼ぶ） */
  setRibbonMode(enabled: boolean): void {
    this.ribbonMode = enabled;
  }

  async init(): Promise<void> {
    const { canvas, format } = this.renderer;
    await this.brushRenderer.init(canvas.width * 4, canvas.height * 4, BUFFER_FORMAT);
    await this.ribbonRenderer.init(canvas.width, canvas.height, BUFFER_FORMAT);
    await this.tileBaker.init();
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
    this.invalidate();
  }

  invalidate(): void {
    this.renderDirty = true;
  }

  setEraseMode(enabled: boolean): void {
    this.eraseMode = enabled;
  }

  // --- テクスチャ生成 ---

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
    const strokeUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    this.strokeAccumTexture = this.renderer.device.createTexture({ size: [width, height], format: BUFFER_FORMAT, usage: strokeUsage });
    this.liveCombinedTexture = this.renderer.device.createTexture({ size: [width, height], format: BUFFER_FORMAT, usage: strokeUsage });
    this.hasStrokeAccum = false;
    const cacheUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    this.baseCache = this.renderer.device.createTexture({ size: [width, height], format: BUFFER_FORMAT, usage: cacheUsage });
    this.displayCache = this.renderer.device.createTexture({ size: [width, height], format: BUFFER_FORMAT, usage: cacheUsage });
    const compUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    this.compA = this.renderer.device.createTexture({ size: [width, height], format: BUFFER_FORMAT, usage: compUsage });
    this.compB = this.renderer.device.createTexture({ size: [width, height], format: BUFFER_FORMAT, usage: compUsage });
    this.blankTile = this.renderer.device.createTexture({
      size: [TILE_SIZE, TILE_SIZE], format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
    this.updateBlankTile();
    this.activeComposite = this.renderer.device.createTexture({
      size: [width, height], format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // 効果の入力ソースがレイヤー指定のとき、処理結果を一時保持する
    this.filterScratch = this.renderer.device.createTexture({
      size: [width, height], format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    // セル効果チェーン処理用のテクスチャ（ping-pong）
    this.cellProcTemp = this.renderer.device.createTexture({
      size: [width, height], format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // T1: タイル合成・サンプリング・readback 用の共有 scratch
    const scratchUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    this.composeScratch = this.renderer.device.createTexture({
      size: [width, height], format: BUFFER_FORMAT, usage: scratchUsage,
    });
    // T1: modal プレビュー（移動・変形）保持用
    this.previewTexture = this.renderer.device.createTexture({
      size: [width, height], format: BUFFER_FORMAT, usage: scratchUsage,
    });
    this.composedTag = null;
    this.previewOverride = null;
    // T1: タイルストア（旧インスタンスがあれば破棄）
    // デバッグフック: window.__tileBudgetMB で予算を上書きできる（verify 用）
    this.tileStore?.clearAll();
    const budgetMB = Number((window as any).__tileBudgetMB ?? 1536);
    this.tileStore = new TileStore(this.renderer.device, width, height, {
      gpuBudgetBytes: Math.max(1, Math.floor(budgetMB)) * 1024 * 1024,
    });

    // レイヤーを初期化（1枚のセル）
    this.destroyAllCellTextures();
    this.rootNodes = [this.createEmptyCell('レイヤー 1')];
    this.rootEffects = [];
    this.activeCellId = this.rootNodes[0].id;
    this.repinActive(null);
    // グリッドが変わるため旧 dirty は破棄して全タイル再計算
    this.dirtyBase.clear();
    this.dirtyDisplay.clear();
    this.markAllTilesDirty();
  }

  private destroyAllCellTextures(): void {
    this.tileStore?.clearAll();
    this.nonEmptyCells.clear();
    this.composedTag = null;
    this.previewOverride = null;
  }

  /** 新規セルは空のまま作り、最初の描画時までタイルを確保しない。 */
  private createEmptyCell(name: string): CellNode {
    return createCell(name);
  }

  /** セル内容変更後に呼ぶ。占有と composed キャッシュタグの整合を保つ */
  private syncNonEmpty(cellId: string): void {
    if (this.tileStore.getOccupancy(cellId).size > 0) this.nonEmptyCells.add(cellId);
    else this.nonEmptyCells.delete(cellId);
  }

  // ── T2 ダーティ追跡 ──

  /** 全タイルを両キャッシュで汚す（初期化・リサイズ・背景変更用） */
  private markAllTilesDirty(): void {
    const n = this.tileStore.tilesX * this.tileStore.tilesY;
    for (let i = 0; i < n; i++) { this.dirtyBase.add(i); this.dirtyDisplay.add(i); }
  }

  /** 指定タイルを両キャッシュで汚す */
  private markTilesDirty(indices: Iterable<number>): void {
    for (const t of indices) { this.dirtyBase.add(t); this.dirtyDisplay.add(t); }
  }

  /** セルの占有タイルを両キャッシュで汚す */
  private markCellDirty(cellId: string): void {
    this.markTilesDirty(this.tileStore.getOccupancy(cellId));
  }

  /** 全セルの占有和を両キャッシュで汚す（並べ替え等の広域操作用。上限40タイル） */
  private markAllOccupiedDirty(): void {
    for (const cell of flattenCells(this.rootNodes)) this.markCellDirty(cell.id);
  }

  /** display のみ汚す（効果パラメータ用） */
  private markDisplayDirty(indices: Iterable<number>): void {
    for (const t of indices) this.dirtyDisplay.add(t);
  }

  /** 全セルの占有和を display のみ汚す（撮影スタック操作用） */
  private markAllOccupiedDisplayDirty(): void {
    for (const cell of flattenCells(this.rootNodes)) {
      this.markDisplayDirty(this.tileStore.getOccupancy(cell.id));
    }
  }

  /** 指定タイルがいずれかのセルに占有されているか */
  private isTileOccupied(index: number): boolean {
    for (const cell of flattenCells(this.rootNodes)) {
      if (this.tileStore.getOccupancy(cell.id).has(index)) return true;
    }
    return false;
  }

  /** blankTile を背景色で更新（背景変更時に呼ぶ） */
  private updateBlankTile(): void {
    const bg = this.backgroundColor;
    const color = bg ? { r: bg.r, g: bg.g, b: bg.b, a: 1 } : { r: 0, g: 0, b: 0, a: 0 };
    // 1px 書き込みでは全域に広がらないため、小さなレンダーパスでクリアする
    const enc = this.renderer.device.createCommandEncoder();
    enc.beginRenderPass({
      colorAttachments: [{ view: this.blankTile.createView(), clearValue: color, loadOp: 'clear', storeOp: 'store' }],
    }).end();
    this.renderer.device.queue.submit([enc.finish()]);
  }

  /** アクティブセルのピン留めを付け替える（ストローク中の退避防止） */
  private repinActive(prevId: string | null): void {
    if (prevId && prevId !== this.activeCellId) this.tileStore.pinOwner(prevId, false);
    if (this.activeCellId) this.tileStore.pinOwner(this.activeCellId, true);
  }

  /** 予算維持を后台で回す（fire-and-forget）。描画系は同期的正しさを保つ */
  private maintainTiles(): void {
    void this.tileStore.maintain().then((ok) => {
      if (!ok) console.warn('[tiles] over budget: all tiles pinned');
    });
  }

  /** タイル統計（診断・verify 用） */
  tileStats(): { tileCount: number; gpuBytes: number; spillBytes: number; budgetBytes: number; cells: number; evictions: number } {
    return this.tileStore.stats();
  }

  /**
   * owner（セル or 履歴）の内容を composeScratch へ合成する。
   * タグが有効なら何もしない。サンプリング・readback・ブレンド入力用。
   */
  private ensureComposed(owner: string): GPUTexture {
    const tag = this.composedTag;
    if (!tag || tag.owner !== owner || tag.version !== this.tileStore.version(owner)) {
      this.clearTextureContent(this.composeScratch);
      this.tileStore.composeCell(owner, this.composeScratch);
      this.composedTag = { owner, version: this.tileStore.version(owner) };
    }
    return this.composeScratch;
  }

  /** アクティブセルの合成ビュー（stamp-mix/alphaLock サンプリング用） */
  private activeComposedView(): GPUTexture {
    if (!this.activeCellId) throw new Error('No active cell');
    return this.ensureComposed(this.activeCellId);
  }

  /** ストローク点列の bbox（size=半径を含む） */
  private static strokePointsBounds(points: StrokePoint[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (points.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x - p.size);
      minY = Math.min(minY, p.y - p.size);
      maxX = Math.max(maxX, p.x + p.size);
      maxY = Math.max(maxY, p.y + p.size);
    }
    return { minX, minY, maxX, maxY };
  }

  /** bbox をタイル index 列挙（±2px のAAマージン付き） */
  private tilesForBounds(b: { minX: number; minY: number; maxX: number; maxY: number } | null): number[] {
    if (!b) return [];
    return this.tileStore.rectToTiles(b.minX - 2, b.minY - 2, b.maxX + 2, b.maxY + 2);
  }

  /** strokeAccumBBox へ点列 bbox を吸収する */
  private absorbAccumBounds(points: StrokePoint[]): void {
    const bb = RenderPipeline.strokePointsBounds(points);
    if (!bb) return;
    const cur = this.strokeAccumBBox;
    this.strokeAccumBBox = cur ? {
      minX: Math.min(cur.minX, bb.minX), minY: Math.min(cur.minY, bb.minY),
      maxX: Math.max(cur.maxX, bb.maxX), maxY: Math.max(cur.maxY, bb.maxY),
    } : { ...bb };
  }

  /**
   * fullscreen ソースを owner の指定タイルへ焼く（T1 の committed 書き込み経路）。
   * mode: over=通常/凍結、erase=消しゴム、max=一筆内蓄積。
   */
  private bakeFullscreenToTiles(
    owner: string, src: GPUTexture, mode: TileBakeMode, indices: number[],
  ): void {
    let wrote = false;
    for (const index of indices) {
      const tx = TileStore.txOf(index, this.tileStore.tilesX);
      const ty = TileStore.tyOf(index, this.tileStore.tilesX);
      const r = this.tileStore.tileRect(tx, ty);
      if (r.w <= 0 || r.h <= 0) continue;
      const tex = this.tileStore.getTile(owner, tx, ty);
      this.tileBaker.bakeRect(src, tex, mode, r.x, r.y, r.w, r.h, this.canvasWidth, this.canvasHeight);
      wrote = true;
    }
    // getTile は新規確保時のみ世代を進めるため、既存タイルへの書き込みを通知する。
    // これを忘れると ensureComposed が古い合成ビューを返し、一定エリアごとに
    // 古い内容が表示される（描画中だけ消えて確定で戻る現象の原因）。
    if (wrote) this.tileStore.bumpVersion(owner);
    // 履歴 owner（h:）は表示対象外なので nonEmpty 管理しない
    if (owner.startsWith('h:')) return;
    this.syncNonEmpty(owner);
    this.markTilesDirty(indices);
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
    this.updateBlankTile();
    this.markAllTilesDirty();
    this.invalidate();
  }

  /** 表示変換（ビュー露出=2^EV / トーンマップ / 表示モード）を設定 */
  setDisplayParams(exposure: number, tonemap: TonemapId, mode: DisplayModeId): void {
    this.displayExposure = exposure;
    this.displayTonemap = tonemap;
    this.displayMode = mode;
    this.compositeRenderer.setDisplayParams(exposure, TONEMAP_IDS.indexOf(tonemap), DISPLAY_MODE_IDS.indexOf(mode));
    this.invalidate();
  }

  // --- 描画（アクティブレイヤー対象）---

  setCurrentStroke(points: StrokePoint[]): void {
    this.currentStroke = points;
    this.invalidate();
  }

  /** 長い一筆の開始。確定済み prefix を保持する accumulator を初期化する。 */
  beginIncrementalStroke(alphaLock = this.getActiveLayerAlphaLock()): void {
    this.currentStroke = [];
    this.hasStrokeAccum = false;
    this.strokeAccumBBox = null;
    this.drawAlphaLock = alphaLock;
    this.clearTextureContent(this.strokeAccumTexture);
    // 前のストロークで巨大化した4x bboxを次の一筆へ持ち越さない。
    this.brushBboxTexture?.destroy();
    this.brushBboxTexture = null;
    this.brushBboxSize = { w: 0, h: 0 };
    this.invalidate();
  }

  /**
   * 確定した prefix を一筆内 accumulator へ追加する。
   * スタンプ・リボンとも max 合成（一筆内の重なりで濃くしない）。
   */
  appendIncrementalStroke(points: StrokePoint[]): void {
    if (points.length === 0) return;
    // accumulator の内容 bbox を追跡（タイル書き戻し範囲用）
    this.absorbAccumBounds(points);
    if (this.ribbonMode) {
      this.drawRibbonToIsolated(points);
      this.compositeRenderer.mergeMax(this.isolatedTexture, this.strokeAccumTexture);
    } else {
      this.drawToIsolated(points);
      this.compositeRenderer.mergeMax(this.isolatedTexture, this.strokeAccumTexture);
    }
    this.hasStrokeAccum = true;
    this.invalidate();
  }

  /** 残りの末尾を追加し、一筆として committed へ一度だけ合成する。 */
  finishIncrementalStroke(points: StrokePoint[], eraseMode = this.eraseMode): void {
    this.finishIncrementalStrokeToOwner(points, eraseMode, this.activeCellId);
  }

  /** finishIncrementalStroke の owner 指定版（履歴再生用） */
  finishIncrementalStrokeToOwner(points: StrokePoint[], eraseMode: boolean, owner: string | null): void {
    if (points.length > 0) this.appendIncrementalStroke(points);
    if (this.hasStrokeAccum && owner) {
      this.bakeFullscreenToTiles(owner, this.strokeAccumTexture, eraseMode ? 'erase' : 'over', this.tilesForBounds(this.strokeAccumBBox));
    }
    this.currentStroke = [];
    this.hasStrokeAccum = false;
    this.strokeAccumBBox = null;
    this.maintainTiles();
    this.invalidate();
  }

  commitStroke(points: StrokePoint[]): void {
    if (points.length > 0 && this.activeCellId) {
      this.drawAlphaLock = this.getActiveLayerAlphaLock();
      if (this.ribbonMode) this.drawRibbonToIsolated(points);
      else this.drawToIsolated(points);
      this.bakeFullscreenToTiles(
        this.activeCellId, this.isolatedTexture, this.eraseMode ? 'erase' : 'over',
        this.tilesForBounds(RenderPipeline.strokePointsBounds(points)),
      );
    }
    this.currentStroke = [];
    this.hasStrokeAccum = false;
    this.strokeAccumBBox = null;
    this.maintainTiles();
    this.invalidate();
  }

  // 次の drawToIsolated で適用するアルファロック（描画経路ごとに設定）
  private drawAlphaLock = false;

  private drawToIsolated(points: StrokePoint[], alphaLockSource?: GPUTexture): void {
    const { device } = this.renderer;
    // 既定の参照先はアクティブセルの合成ビュー（T1: タイル合成）
    const samplingSource = alphaLockSource ?? this.activeComposedView();
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
    const requiredW4 = aligned.width;
    const requiredH4 = aligned.height;

    // bbox 4x テクスチャはストローク中に grow-only で再利用する。
    // 毎入力で数pxずつ寸法が変わるたびに create/destroy するのを避ける。
    if (!this.brushBboxTexture || this.brushBboxSize.w < requiredW4 || this.brushBboxSize.h < requiredH4) {
      this.brushBboxTexture?.destroy();
      const grow = (required: number, current: number, limit: number) => {
        let size = Math.max(4, current || 4);
        while (size < required) size *= 2;
        return Math.min(size, limit);
      };
      const bboxW4 = grow(requiredW4, this.brushBboxSize.w, cw4);
      const bboxH4 = grow(requiredH4, this.brushBboxSize.h, ch4);
      this.brushBboxTexture = device.createTexture({
        size: [bboxW4, bboxH4],
        format: BUFFER_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.brushBboxSize = { w: bboxW4, h: bboxH4 };
    }
    const bboxW4 = this.brushBboxSize.w;
    const bboxH4 = this.brushBboxSize.h;

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.brushBboxTexture!.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
    });
    this.brushRenderer.renderStroke(
      pass, points, samplingSource, SCALE,
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
   * リボン筆の描画。4x bbox + downsample を通さず、isolated へ max で直接描く。
   * 輪郭AAはシェーダー側の SDF + fwidth で行う。
   * 1点のみ（クリックのドット）は面積ゼロのためスタンプにフォールバックする。
   */
  private drawRibbonToIsolated(points: StrokePoint[], alphaLockSource?: GPUTexture): void {
    if (points.length < 2) {
      this.drawToIsolated(points, alphaLockSource);
      return;
    }
    const samplingSource = alphaLockSource ?? this.activeComposedView();
    const { device } = this.renderer;
    this.ribbonRenderer.updateConfig({ alphaLock: this.drawAlphaLock });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.isolatedTexture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
    });
    this.ribbonRenderer.renderStroke(pass, points, samplingSource);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /**
   * T2: ライブストロークの一時テクスチャを構築する（activeComposite へ）。
   * base への erase もここで解決するため、display 側の重ねは常に over でよい。
   * ストロークなし → null。
   */
  private buildLiveFullscreen(): GPUTexture | null {
    const { device } = this.renderer;
    if ((this.currentStroke.length === 0 && !this.hasStrokeAccum) || !this.activeCellId) return null;
    const activeCell = findCell(this.rootNodes, this.activeCellId);
    if (!activeCell) return null;
    this.drawAlphaLock = activeCell.alphaLock;
    let liveStrokeTexture: GPUTexture;
    if (this.currentStroke.length > 0) {
      if (this.ribbonMode) this.drawRibbonToIsolated(this.currentStroke);
      else this.drawToIsolated(this.currentStroke);
      if (this.hasStrokeAccum) {
        const liveCopy = device.createCommandEncoder();
        liveCopy.copyTextureToTexture(
          { texture: this.strokeAccumTexture }, { texture: this.liveCombinedTexture },
          [this.canvasWidth, this.canvasHeight],
        );
        device.queue.submit([liveCopy.finish()]);
        this.compositeRenderer.mergeMax(this.isolatedTexture, this.liveCombinedTexture);
        liveStrokeTexture = this.liveCombinedTexture;
      } else {
        liveStrokeTexture = this.isolatedTexture;
      }
    } else {
      liveStrokeTexture = this.strokeAccumTexture;
    }
    // active のタイル合成をコピーしてから isolated を over/erase で重ねる
    const activeView = this.activeComposedView();
    const copyEnc = device.createCommandEncoder();
    copyEnc.copyTextureToTexture(
      { texture: activeView }, { texture: this.activeComposite },
      [this.canvasWidth, this.canvasHeight],
    );
    device.queue.submit([copyEnc.finish()]);
    this.compositeRenderer.bake(liveStrokeTexture, this.activeComposite, this.eraseMode);
    return this.activeComposite;
  }

  /** ライブストロークの bbox タイル（display dirty 用） */
  private liveTiles(): number[] {
    const tail = RenderPipeline.strokePointsBounds(
      this.currentStroke.length > 0 ? this.currentStroke : [],
    );
    const acc = this.strokeAccumBBox;
    const union = tail && acc ? {
      minX: Math.min(tail.minX, acc.minX), minY: Math.min(tail.minY, acc.minY),
      maxX: Math.max(tail.maxX, acc.maxX), maxY: Math.max(tail.maxY, acc.maxY),
    } : (tail ?? acc);
    return this.tilesForBounds(union);
  }

  /**
   * T2: 層スタックのブレンド op 列を構築する（scissor タイル単位・1submit）。
   * override 指定時はそのセルのソースを fullscreen テクスチャに差し替える。
   * 戻り値は op 列とタイル毎の最終バッファ。
   */
  private buildStackOps(
    tiles: Set<number>,
    override?: { cellId: string; tex: GPUTexture; tiles: Set<number> },
  ): { ops: TileBlendOp[]; endsIn: Map<number, GPUTexture>; empty: Set<number> } {
    const ops: TileBlendOp[] = [];
    const endsIn = new Map<number, GPUTexture>();
    const empty = new Set<number>();
    const cells = visibleCells(this.rootNodes);
    for (const t of tiles) {
      const r = this.tileStore.tileRect(
        TileStore.txOf(t, this.tileStore.tilesX), TileStore.tyOf(t, this.tileStore.tilesX),
      );
      const scissor = { x: r.x, y: r.y, w: r.w, h: r.h };
      let dst = this.compA, other = this.compB;
      let count = 0;
      for (const cell of cells) {
        if (cell.opacity <= 0) continue;
        // override（ライブ・modal プレビュー）は指定タイルだけ fullscreen 差替
        if (override && cell.id === override.cellId && override.tiles.has(t)) {
          ops.push({
            dst, target: other, mode: cell.blendMode, opacity: cell.opacity,
            tileOx: 0, tileOy: 0, scissor, srcFull: override.tex,
          });
          const tmp = dst; dst = other; other = tmp;
          count++;
          continue;
        }
        if (!this.tileStore.getOccupancy(cell.id).has(t)) continue;
        const tex = this.tileStore.ensureResidentTile(cell.id, t);
        if (!tex) continue;
        ops.push({
          dst, srcTile: tex, target: other, mode: cell.blendMode, opacity: cell.opacity,
          tileOx: r.x, tileOy: r.y, scissor,
        });
        const tmp = dst; dst = other; other = tmp;
        count++;
      }
      if (count === 0) { empty.add(t); continue; }
      endsIn.set(t, count % 2 === 1 ? this.compB : this.compA);
    }
    return { ops, endsIn, empty };
  }

  /** T2: ダーティタイルの層スタックを baseCache へ再計算する */
  private recomputeBaseTiles(tiles: Set<number>): void {
    if (tiles.size === 0) return;
    const n = this.tileStore.tilesX * this.tileStore.tilesY;
    for (const t of tiles) {
      if (t < 0 || t >= n || !Number.isInteger(t)) {
        console.warn(`[tiles] invalid base tile ${t} (grid ${this.tileStore.tilesX}x${this.tileStore.tilesY} canvas ${this.canvasWidth}x${this.canvasHeight})`);
        tiles.delete(t);
      }
    }
    if (tiles.size === 0) return;
    const { device } = this.renderer;
    this.clearToBackground(this.compA);
    const { ops, endsIn, empty } = this.buildStackOps(tiles);
    this.blendRenderer.blendTiles(ops);
    // 結果を baseCache へ。空タイルは下地コピー
    const enc = device.createCommandEncoder();
    for (const t of tiles) {
      const r = this.tileStore.tileRect(
        TileStore.txOf(t, this.tileStore.tilesX), TileStore.tyOf(t, this.tileStore.tilesX),
      );
      if (empty.has(t)) {
        enc.copyTextureToTexture(
          { texture: this.blankTile, origin: { x: 0, y: 0 } },
          { texture: this.baseCache, origin: { x: r.x, y: r.y } },
          [r.w, r.h],
        );
      } else {
        const src = endsIn.get(t)!;
        enc.copyTextureToTexture(
          { texture: src, origin: { x: r.x, y: r.y } },
          { texture: this.baseCache, origin: { x: r.x, y: r.y } },
          [r.w, r.h],
        );
      }
    }
    device.queue.submit([enc.finish()]);
  }

  /** T2: ダーティタイルの撮影を displayCache へ再計算する（override 対応） */
  private recomputeDisplayTiles(
    tiles: Set<number>,
    override?: { cellId: string; tex: GPUTexture; tiles: Set<number> },
  ): void {
    if (tiles.size === 0) return;
    const n = this.tileStore.tilesX * this.tileStore.tilesY;
    for (const t of tiles) {
      if (t < 0 || t >= n || !Number.isInteger(t)) {
        console.warn(`[tiles] invalid display tile ${t} (grid ${this.tileStore.tilesX}x${this.tileStore.tilesY})`);
        tiles.delete(t);
      }
    }
    if (tiles.size === 0) return;
    const { device } = this.renderer;
    const chain = this.rootEffects.filter(e => e.visible && e.opacity > 0);
    // 層スタック（override があれば差替）→ compA/B
    const { ops, endsIn } = this.buildStackOps(tiles, override);
    this.blendRenderer.blendTiles(ops);
    const enc = device.createCommandEncoder();
    for (const t of tiles) {
      const r = this.tileStore.tileRect(
        TileStore.txOf(t, this.tileStore.tilesX), TileStore.tyOf(t, this.tileStore.tilesX),
      );
      const scissor = { x: r.x, y: r.y, w: r.w, h: r.h };
      // override タイルは endsIn がなければ空（override テクスチャ自体が透明）
      const stacked = endsIn.get(t);
      if (!stacked) {
        if (chain.length === 0) {
          enc.copyTextureToTexture(
            { texture: this.blankTile, origin: { x: 0, y: 0 } },
            { texture: this.displayCache, origin: { x: r.x, y: r.y } },
            [r.w, r.h],
          );
          continue;
        }
        // chain 入力は下地。compA の当該矩形へ用意する
        enc.copyTextureToTexture(
          { texture: this.blankTile, origin: { x: 0, y: 0 } },
          { texture: this.compA, origin: { x: r.x, y: r.y } },
          [r.w, r.h],
        );
        this.runChainToDisplay(this.compA, scissor, chain);
        continue;
      }
      if (chain.length === 0) {
        enc.copyTextureToTexture(
          { texture: stacked, origin: { x: r.x, y: r.y } },
          { texture: this.displayCache, origin: { x: r.x, y: r.y } },
          [r.w, r.h],
        );
      } else {
        this.runChainToDisplay(stacked, scissor, chain);
      }
    }
    device.queue.submit([enc.finish()]);
  }

  /** 撮影チェーンを baseCache 由来で displayCache の scissor へ流す */
  private runChainToDisplay(
    src: GPUTexture,
    scissor: { x: number; y: number; w: number; h: number },
    chain: EffectChainItem[],
  ): void {
    let read: GPUTexture = src;
    let write = read === this.compA ? this.compB : this.compA;
    chain.forEach((eff, i) => {
      if (eff.filterType === 'curve' && eff.curvePoints) {
        this.filterRenderer.setCurveLut(buildCurveLut(eff.curvePoints));
      }
      const dst = i === chain.length - 1 ? this.displayCache : write;
      this.filterRenderer.apply(eff.filterType, eff.params, read, null, dst, eff.opacity, scissor);
      read = dst === this.displayCache ? dst : write;
      if (dst !== this.displayCache) write = write === this.compA ? this.compB : this.compA;
    });
  }

  /**
   * セルの効果チェーンを順に適用した結果テクスチャを返す
   * アクティブセルのライブストロークがある場合は、それを元に効果を適用する
   */
  private applyCellEffects(cell: CellNode, committed: GPUTexture, liveSrc: GPUTexture | null): GPUTexture {
    const base = liveSrc ?? committed;
    // 効果チェーンを ping-pong で適用: cellProcTemp ↔ filterScratch
    let src = base;
    let dst = this.cellProcTemp;
    for (let i = 0; i < cell.effects.length; i++) {
      const eff = cell.effects[i];
      if (!eff.visible) continue;
      if (eff.filterType === 'curve' && eff.curvePoints) {
        this.filterRenderer.setCurveLut(buildCurveLut(eff.curvePoints));
      }
      this.filterRenderer.apply(eff.filterType, eff.params, src, null, dst, eff.opacity);
      src = dst;
      dst = dst === this.cellProcTemp ? this.filterScratch : this.cellProcTemp;
    }
    return src;
  }

  /** base/display キャッシュをきれいにする（live なし）。snapshot/export/freeze 用 */
  private ensureCachesClean(): void {
    if (this.dirtyBase.size > 0) {
      this.recomputeBaseTiles(this.dirtyBase);
      this.dirtyBase.clear();
    }
    if (this.dirtyDisplay.size > 0) {
      this.recomputeDisplayTiles(this.dirtyDisplay);
      this.dirtyDisplay.clear();
    }
  }

  render(): boolean {
    // base 再計算
    if (this.dirtyBase.size > 0) {
      this.recomputeBaseTiles(this.dirtyBase);
      this.dirtyBase.clear();
    }
    // ライブ/プレビューの override 解決
    let override: { cellId: string; tex: GPUTexture; tiles: Set<number> } | undefined;
    if (this.previewOverride && this.activeCellId) {
      // modal 中: 全占有を毎フレーム再計算
      const all = new Set<number>();
      for (const cell of flattenCells(this.rootNodes)) {
        for (const t of this.tileStore.getOccupancy(cell.id)) all.add(t);
      }
      for (const t of all) this.dirtyDisplay.add(t);
      override = { cellId: this.previewOverride.cellId, tex: this.previewOverride.texture, tiles: all };
    } else {
      const liveTex = this.buildLiveFullscreen();
      if (liveTex && this.activeCellId) {
        const lt = new Set(this.liveTiles());
        for (const t of lt) this.dirtyDisplay.add(t);
        override = { cellId: this.activeCellId, tex: liveTex, tiles: lt };
      }
    }
    let redrew = false;
    if (this.dirtyDisplay.size > 0) {
      this.recomputeDisplayTiles(this.dirtyDisplay, override);
      this.dirtyDisplay.clear();
      redrew = true;
    }
    if (!this.renderDirty && !redrew) return false;
    const { device, context } = this.renderer;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 0.05, g: 0.05, b: 0.05, a: 1.0 }, loadOp: 'clear', storeOp: 'store' }],
    });
    this.compositeRenderer.drawPaper(pass);
    this.compositeRenderer.draw(pass, this.displayCache);
    pass.end();
    device.queue.submit([encoder.finish()]);
    this.renderDirty = false;
    return true;
  }

  // --- レイヤー操作（3オブジェクト構造） ---

  /** レイヤーツリーを取得（UI用） */
  getRootNodes(): LayerNode[] {
    return this.rootNodes;
  }

  /** ルート効果チェーン（撮影スタック）を取得（UI用） */
  getRootEffects(): EffectChainItem[] {
    return this.rootEffects;
  }

  /**
   * セルの合成ビューを取得（UIのプレビュー等用）。
   * 共有 scratch を返すため、次の compose で内容が変わる。すぐ使うこと。
   */
  getCellTexture(cellId: string): GPUTexture | null {
    if (this.tileStore.getOccupancy(cellId).size === 0) return null;
    return this.ensureComposed(cellId);
  }

  setLayerAlphaLock(id: string, locked: boolean): void {
    const cell = findCell(this.rootNodes, id);
    if (cell) cell.alphaLock = locked;
  }

  // --- 効果チェーン ---

  /** 効果構造変化時の display 汚し（はみ出しを見込んで広めに取る） */
  private markEffectStructureDirty(owner: { kind: 'cell'; cellId: string } | { kind: 'root' }): void {
    if (owner.kind === 'root') {
      this.markAllOccupiedDisplayDirty();
    } else {
      this.markDisplayDirty(this.dilatedTiles(owner.cellId, 128));
    }
  }

  /** 効果をセルの効果チェーンに追加 */
  addEffectToCell(cellId: string, type: FilterType): string {
    const cell = findCell(this.rootNodes, cellId);
    if (!cell) throw new Error(`Cell ${cellId} not found`);
    const eff = createEffect(type);
    cell.effects.push(eff);
    this.markEffectStructureDirty({ kind: 'cell', cellId });
    this.invalidate();
    return eff.id;
  }

  /** 効果をルート効果チェーン（撮影スタック）に追加 */
  addEffectToRoot(type: FilterType): string {
    const eff = createEffect(type);
    this.rootEffects.push(eff);
    this.markEffectStructureDirty({ kind: 'root' });
    this.invalidate();
    return eff.id;
  }

  /** 効果のパラメータを更新 */
  setEffectParams(id: string, params: Partial<FilterParams>): void {
    const found = findEffect(this.rootNodes, this.rootEffects, id);
    if (found) {
      found.effect.params = { ...found.effect.params, ...params };
      if (found.owner.kind === 'root') {
        this.markAllOccupiedDisplayDirty();
      } else {
        const cell = findCell(this.rootNodes, found.owner.cellId);
        const spread = cell ? this.effectSpreadPx(cell) : 0;
        this.markDisplayDirty(this.dilatedTiles(found.owner.cellId, spread));
      }
      this.invalidate();
    }
  }

  /** 効果(curve)の制御点を更新 */
  setEffectCurve(id: string, points: CurvePoint[]): void {
    const found = findEffect(this.rootNodes, this.rootEffects, id);
    if (found) {
      found.effect.curvePoints = points.map(p => ({ ...p }));
      if (found.owner.kind === 'root') {
        this.markAllOccupiedDisplayDirty();
      } else {
        this.markDisplayDirty(this.dilatedTiles(found.owner.cellId, 0));
      }
      this.invalidate();
    }
  }

  /** 効果の情報取得（UIのパラメータ編集用） */
  getEffect(id: string): { filterType: FilterType; params: FilterParams; curvePoints?: CurvePoint[]; owner: { kind: 'cell'; cellId: string } | { kind: 'root' } } | null {
    const found = findEffect(this.rootNodes, this.rootEffects, id);
    if (!found) return null;
    return { filterType: found.effect.filterType, params: found.effect.params, curvePoints: found.effect.curvePoints, owner: found.owner };
  }

  /** 効果を削除 */
  removeEffect(id: string): void {
    // ルート効果から削除
    const rootIdx = this.rootEffects.findIndex(e => e.id === id);
    if (rootIdx >= 0) {
      this.rootEffects.splice(rootIdx, 1);
      this.markEffectStructureDirty({ kind: 'root' });
      this.invalidate();
      return;
    }
    // セルの効果チェーンから削除
    const walk = (nodes: LayerNode[]): boolean => {
      for (const n of nodes) {
        if (n.kind === 'cell') {
          const idx = n.effects.findIndex(e => e.id === id);
          if (idx >= 0) {
            n.effects.splice(idx, 1);
            this.markEffectStructureDirty({ kind: 'cell', cellId: n.id });
            return true;
          }
        } else if (n.kind === 'folder') {
          if (walk(n.children)) return true;
        }
      }
      return false;
    };
    if (walk(this.rootNodes)) this.invalidate();
  }

  /** 効果の表示/非表示を切り替え */
  setEffectVisible(id: string, visible: boolean): void {
    const found = findEffect(this.rootNodes, this.rootEffects, id);
    if (found) {
      found.effect.visible = visible;
      this.markEffectStructureDirty(found.owner);
      this.invalidate();
    }
  }

  /** セル効果のはみ出し半径（blur/glow）。Freeze 書き戻し範囲の拡張用 */
  private effectSpreadPx(cell: CellNode): number {
    let spread = 0;
    for (const eff of cell.effects) {
      if (!eff.visible) continue;
      if (eff.filterType === 'blur' || eff.filterType === 'glow' || eff.filterType === 'sharpen') {
        spread = Math.max(spread, eff.params.radius ?? 0);
      }
    }
    return spread;
  }

  /** 占有タイル集合を半径分だけ拡張したタイル集合 */
  private dilatedTiles(cellId: string, radiusPx: number): number[] {
    const occ = this.tileStore.getOccupancy(cellId);
    if (occ.size === 0 || radiusPx <= 0) return [...occ];
    const out = new Set<number>(occ);
    for (const index of occ) {
      const tx = TileStore.txOf(index, this.tileStore.tilesX);
      const ty = TileStore.tyOf(index, this.tileStore.tilesX);
      const r = this.tileStore.tileRect(tx, ty);
      for (const t of this.tileStore.rectToTiles(r.x - radiusPx, r.y - radiusPx, r.x + r.w + radiusPx, r.y + r.h + radiusPx)) {
        out.add(t);
      }
    }
    return [...out];
  }

  /**
   * Freeze: セルの効果チェーン全体をセルのcommittedに焼き込む。
   * 効果チェーンをクリアし、committed を処理結果で置き換える。
   */
  freezeCellEffects(cellId: string): void {
    const cell = findCell(this.rootNodes, cellId);
    if (!cell || cell.effects.length === 0) return;
    if (this.tileStore.getOccupancy(cellId).size === 0) { cell.effects = []; return; }
    // 効果チェーンを適用した結果をタイルへ書き戻す（ぼかし系のはみ出し分を拡張）
    const committedView = this.ensureComposed(cellId);
    const result = this.applyCellEffects(cell, committedView, null);
    const targets = new Set<number>([
      ...this.tileStore.getOccupancy(cellId),
      ...this.dilatedTiles(cellId, this.effectSpreadPx(cell)),
    ]);
    this.tileStore.releaseCell(cellId);
    this.tileStore.scatterTexture(result, cellId, [...targets], this.tileBaker);
    cell.effects = [];
    this.syncNonEmpty(cellId);
    this.markTilesDirty(targets);
    this.invalidate();
  }

  /**
   * Freeze: ルート効果チェーン全体を全セル合成結果に焼き込む。
   * 全セルを1枚に統合し、ルート効果を適用した結果を単一セルに置換する。
   */
  freezeRootEffects(): void {
    if (this.rootEffects.length === 0) return;
    // T2: display キャッシュ（背景込み・現行表示と一致）を単一セルへ統合する。
    // 旧実装は透明下地だったが、表示/PNG と一致する方を採用する。
    this.ensureCachesClean();
    const result = this.displayCache;
    // 全セルを破棄して単一セルに置換（占有は全セルの和＝過剰保持あり・上限40）
    const union = new Set<number>();
    for (const cell of flattenCells(this.rootNodes)) {
      for (const t of this.tileStore.getOccupancy(cell.id)) union.add(t);
    }
    this.destroyAllCellTextures();
    const cell = createCell('統合レイヤー');
    // 空の統合結果でもタイルは確保しない（union が空なら占有なし）
    if (union.size > 0) {
      this.tileStore.scatterTexture(result, cell.id, [...union], this.tileBaker);
    }
    this.rootNodes = [cell];
    this.rootEffects = [];
    this.activeCellId = cell.id;
    this.syncNonEmpty(cell.id);
    this.repinActive(null);
    this.markTilesDirty(union);
    this.maintainTiles();
    this.invalidate();
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
    this.ribbonRenderer.setSelectionTexture(this.selectionMask);
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
    this.ribbonRenderer.setSelectionTexture(null);
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
    if (this.activeCellId) this.beginPreview(this.activeCellId);
    return { lx, ty, rx, by };
  }

  /**
   * aligned CPU 画像を previewTexture へ書き込む（移動ドラッグ用）。
   * bytesPerRow は 256 アライン済みを想定（writeTexture はアライン不要）。
   */
  private writePreviewFromAligned(data: Uint16Array, bytesPerRow: number): void {
    this.renderer.device.queue.writeTexture(
      { texture: this.previewTexture },
      data as unknown as BufferSource,
      { bytesPerRow, rowsPerImage: this.canvasHeight },
      [this.canvasWidth, this.canvasHeight],
    );
  }

  /** modal プレビュー開始（移動・変形）。表示は previewTexture に切り替わる */
  private beginPreview(cellId: string): void {
    // 現在内容をプレビューへ複写してから override する
    const view = this.ensureComposed(cellId);
    const enc = this.renderer.device.createCommandEncoder();
    enc.copyTextureToTexture(
      { texture: view }, { texture: this.previewTexture },
      [this.canvasWidth, this.canvasHeight],
    );
    this.renderer.device.queue.submit([enc.finish()]);
    this.previewOverride = { cellId, texture: this.previewTexture };
    this.invalidate();
  }

  /** modal プレビュー終了。tiles への書き戻しは呼び出し側で行う */
  private endPreview(): void {
    this.previewOverride = null;
    this.invalidate();
  }

  /**
   * 変形を適用してプレビューを更新（ドラッグ中の毎フレーム呼ぶ）。
   * invMatrix: row-major 3x3 を array<vec4f,3> 形式の 12 floats で渡す。
   * committed タイルは確定まで触らない。
   */
  updateTransform(invMatrix: Float32Array): void {
    if (!this.txActive || !this.txSrcTexture || !this.txBaseTexture || !this.txBounds) return;
    const { lx, ty, rx, by } = this.txBounds;
    this.transformRenderer.render(
      this.txSrcTexture,
      this.txBaseTexture,
      this.previewTexture,
      invMatrix,
      rx - lx, by - ty,
      this.canvasWidth, this.canvasHeight,
    );
    this.invalidate();
  }

  /** 変形確定。プレビューをタイルへ書き戻し、Undo 用スナップショットを返す */
  commitTransform(): { snapshot: Uint16Array; bytesPerRow: number } | null {
    if (!this.txActive || !this.txSnapshot || !this.activeCellId) return null;
    const snapshot = this.txSnapshot;
    const bytesPerRow = Math.ceil(this.canvasWidth * 8 / 256) * 256;
    // 書き戻し範囲: 旧占有 ∪ 変形 bounds（1タイル余裕）。過剰保持は上限40で有界
    const targets = new Set<number>(this.tileStore.getOccupancy(this.activeCellId));
    if (this.txBounds) {
      const { lx, ty, rx, by } = this.txBounds;
      for (const t of this.tileStore.rectToTiles(lx - TILE_MARGIN, ty - TILE_MARGIN, rx + TILE_MARGIN, by + TILE_MARGIN)) {
        targets.add(t);
      }
    }
    this.tileStore.scatterTexture(this.previewTexture, this.activeCellId, [...targets], this.tileBaker);
    this.syncNonEmpty(this.activeCellId);
    this.markTilesDirty(targets);
    this.endPreview();
    this.maintainTiles();
    this._clearTransformState();
    return { snapshot, bytesPerRow };
  }

  /** 変形キャンセル: タイルは触っていないのでプレビューを捨てるだけ */
  cancelTransform(): void {
    if (!this.txActive || !this.txSnapshot) return;
    this.endPreview();
    // ドラッグ中に preview 由来で再計算した display を戻す
    this.markAllOccupiedDisplayDirty();
    this._clearTransformState();
  }

  private _clearTransformState(): void {
    this.txActive = false;
    this.txSnapshot = null;
    this.txSrcTexture?.destroy(); this.txSrcTexture = null;
    this.txBaseTexture?.destroy(); this.txBaseTexture = null;
    this.txBounds = null;
  }

  // --- 破壊的フィルターモーダル（死にコード: main から未使用。効果チェーンが現行経路）---
  // T1 で削除。filterRenderer 自体は効果チェーン（非破壊）で使用中のため残す。
  // --- 移動ツール（T1: previewTexture＋override 方式。タイルは確定まで触らない） ---
  private moveActive = false;
  private moveLastDx = 0;
  private moveLastDy = 0;
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
    this.moveLastDx = 0;
    this.moveLastDy = 0;

    // T1: 穴あき版をプレビューへ（タイルは確定まで触らない）
    const bytesPerRow = Math.ceil(w * 8 / 256) * 256;
    this.writePreviewFromAligned(base, bytesPerRow);
    if (this.activeCellId) {
      this.previewOverride = { cellId: this.activeCellId, texture: this.previewTexture };
    }
    this.invalidate();
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
    this.moveLastDx = ndx;
    this.moveLastDy = ndy;

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

    // T1: プレビューへ書き込み（タイルは確定まで触らない）
    const bytesPerRow = Math.ceil(w * 8 / 256) * 256;
    this.writePreviewFromAligned(this.moveResult, bytesPerRow);
    this.invalidate();
  }

  /**
   * 移動確定。プレビューをタイルへ書き戻し、Undo 用スナップショットを返す。
   */
  commitMove(): { snapshot: Uint16Array; bytesPerRow: number } | null {
    if (!this.moveActive || !this.moveSnapshot || !this.activeCellId) return null;
    const snapshot = this.moveSnapshot;
    const bytesPerRow = Math.ceil(this.canvasWidth * 8 / 256) * 256;
    // 書き戻し範囲: 旧占有 ∪ 移動先 bounds。過剰保持は上限40で有界
    const targets = new Set<number>(this.tileStore.getOccupancy(this.activeCellId));
    if (this.moveContent) {
      const { x, y, w, h } = this.moveContent;
      for (const t of this.tileStore.rectToTiles(x + this.moveLastDx, y + this.moveLastDy, x + w + this.moveLastDx, y + h + this.moveLastDy)) {
        targets.add(t);
      }
    }
    this.tileStore.scatterTexture(this.previewTexture, this.activeCellId, [...targets], this.tileBaker);
    this.syncNonEmpty(this.activeCellId);
    this.markTilesDirty(targets);
    this.endPreview();
    this.maintainTiles();
    this.moveActive = false;
    this.moveSnapshot = null;
    this.moveBase = null;
    this.moveContent = null;
    this.moveResult = null;
    return { snapshot, bytesPerRow };
  }

  /** 移動キャンセル: タイルは触っていないのでプレビューを捨てるだけ */
  cancelMove(): void {
    if (!this.moveActive || !this.moveSnapshot) return;
    this.endPreview();
    this.markAllOccupiedDisplayDirty();
    this.moveActive = false;
    this.moveSnapshot = null;
    this.moveBase = null;
    this.moveContent = null;
    this.moveResult = null;
  }

  getActiveLayerAlphaLock(): boolean {
    if (!this.activeCellId) return false;
    const cell = findCell(this.rootNodes, this.activeCellId);
    return cell?.alphaLock ?? false;
  }

  getActiveLayerId(): string {
    return this.activeCellId ?? '';
  }

  setActiveLayer(id: string): void {
    // セルのみアクティブにできる
    const cell = findCell(this.rootNodes, id);
    if (cell) {
      const prev = this.activeCellId;
      this.activeCellId = id;
      this.repinActive(prev);
    }
  }

  /** セルを追加（アクティブセルのルートレベルの上に挿入） */
  addLayer(): string {
    const cell = this.createEmptyCell(`レイヤー ${flattenCells(this.rootNodes).length + 1}`);
    // アクティブセルと同じ親の子として、その上に挿入
    const parent = this.activeCellId ? findParent(this.rootNodes, this.activeCellId) : null;
    if (parent) {
      parent.parent.splice(parent.index + 1, 0, cell);
    } else {
      this.rootNodes.push(cell);
    }
    const prev = this.activeCellId;
    this.activeCellId = cell.id;
    this.repinActive(prev);
    this.invalidate();
    return cell.id;
  }

  /** フォルダを追加 */
  addFolder(): string {
    const folder = createFolder(`フォルダ ${this.countFolders() + 1}`);
    const parent = this.activeCellId ? findParent(this.rootNodes, this.activeCellId) : null;
    if (parent) {
      parent.parent.splice(parent.index + 1, 0, folder);
    } else {
      this.rootNodes.push(folder);
    }
    this.invalidate();
    return folder.id;
  }

  private countFolders(): number {
    const walk = (nodes: LayerNode[]): number => {
      let count = 0;
      for (const n of nodes) {
        if (n.kind === 'folder') { count++; count += walk(n.children); }
      }
      return count;
    };
    return walk(this.rootNodes);
  }

  removeActiveLayer(): void {
    if (!this.activeCellId) return;
    const cells = flattenCells(this.rootNodes);
    if (cells.length <= 1) return; // 最低1枚は残す
    const prev = this.activeCellId;
    // アクティブセルのタイルを破棄
    this.markCellDirty(this.activeCellId);
    this.tileStore.releaseCell(this.activeCellId);
    this.clearHistoryBase(this.activeCellId);
    this.nonEmptyCells.delete(this.activeCellId);
    // ツリーから削除
    removeNode(this.rootNodes, this.activeCellId);
    // 新しいアクティブセルを選択
    const remaining = flattenCells(this.rootNodes);
    this.activeCellId = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    this.repinActive(prev);
    this.invalidate();
  }

  /** 指定IDのノードを削除（セル or フォルダ） */
  removeNode(id: string): void {
    if (id === this.activeCellId) { this.removeActiveLayer(); return; }
    // フォルダ削除時も配下セルのGPUテクスチャと履歴基準をすべて解放する。
    const node = findNode(this.rootNodes, id);
    const removedCells = node ? (node.kind === 'cell' ? [node] : flattenCells(node.children)) : [];
    for (const cell of removedCells) {
      this.markCellDirty(cell.id);
      this.tileStore.releaseCell(cell.id);
      this.clearHistoryBase(cell.id);
      this.nonEmptyCells.delete(cell.id);
    }
    removeNode(this.rootNodes, id);
    if (removedCells.some(cell => cell.id === this.activeCellId)) {
      const remaining = flattenCells(this.rootNodes);
      this.activeCellId = remaining[remaining.length - 1]?.id ?? null;
    }
    this.invalidate();
  }

  moveActiveLayer(dir: 'up' | 'down'): void {
    if (!this.activeCellId) return;
    moveNode(this.rootNodes, this.activeCellId, dir);
    this.markAllOccupiedDirty();
    this.invalidate();
  }

  /** 指定IDのノードを上下に移動 */
  moveNode(id: string, dir: 'up' | 'down'): void {
    moveNode(this.rootNodes, id, dir);
    this.markAllOccupiedDirty();
    this.invalidate();
  }

  setLayerVisible(id: string, visible: boolean): void {
    const node = findNode(this.rootNodes, id);
    if (node) {
      node.visible = visible;
      // フォルダ可視は配下全体に影響する
      if (node.kind === 'folder') {
        for (const c of flattenCells(node.children)) this.markCellDirty(c.id);
      } else {
        this.markCellDirty(id);
      }
      this.invalidate();
    }
  }

  setLayerOpacity(id: string, opacity: number): void {
    const cell = findCell(this.rootNodes, id);
    if (cell) {
      cell.opacity = opacity;
      this.markCellDirty(id);
      this.invalidate();
    }
  }

  setLayerBlendMode(id: string, mode: BlendMode): void {
    const cell = findCell(this.rootNodes, id);
    if (cell) {
      cell.blendMode = mode;
      this.markCellDirty(id);
      this.invalidate();
    }
  }

  /** フォルダの折りたたみ状態を切り替え */
  setFolderCollapsed(id: string, collapsed: boolean): void {
    const node = findNode(this.rootNodes, id);
    if (node && node.kind === 'folder') {
      node.collapsed = collapsed;
      for (const c of flattenCells(node.children)) this.markCellDirty(c.id);
    }
  }

  /** ノード名を変更 */
  setNodeName(id: string, name: string): void {
    const node = findNode(this.rootNodes, id);
    if (node) node.name = name;
  }

  getCanvasSize(): { width: number; height: number } {
    return { width: this.canvasWidth, height: this.canvasHeight };
  }

  /**
   * 全セルのタイルデータ（tight float16 RGBA・非空のみ）を読み出す
   * .pmx v3 保存用
   */
  async readCellTiles(): Promise<{ cell: CellNode; tiles: { tx: number; ty: number; data: Uint16Array }[] }[]> {
    const out: { cell: CellNode; tiles: { tx: number; ty: number; data: Uint16Array }[] }[] = [];
    const cells = flattenCells(this.rootNodes);
    for (const cell of cells) {
      const occ = this.tileStore.getOccupancy(cell.id);
      if (occ.size === 0) continue;
      const tiles: { tx: number; ty: number; data: Uint16Array }[] = [];
      for (const index of occ) {
        const tx = TileStore.txOf(index, this.tileStore.tilesX);
        const ty = TileStore.tyOf(index, this.tileStore.tilesX);
        tiles.push({ tx, ty, data: await this.tileStore.readTile(cell.id, index) });
      }
      out.push({ cell, tiles });
    }
    return out;
  }

  /**
   * .pmx 読込（新形式）: レイヤーツリー + ルート効果チェーンを復元する
   */
  loadDocument(width: number, height: number, nodes: LayerNode[], rootEffects: EffectChainItem[], activeId: string): void {
    this.resizeCanvasSize(width, height);
    // 既存テクスチャを破棄
    this.destroyAllCellTextures();
    // 新しいツリーを構築。各セルのテクスチャはデータ書込時に遅延確保する。
    this.rootNodes = nodes;
    this.rootEffects = rootEffects;
    if (flattenCells(this.rootNodes).length === 0) {
      const cell = this.createEmptyCell('レイヤー 1');
      this.rootNodes = [cell];
    }
    this.activeCellId = activeId || flattenCells(this.rootNodes)[0]?.id || null;
    this.repinActive(null);
    this.maintainTiles();
    this.invalidate();
  }

  /**
   * .pmx v3 読込: セルのタイルデータを書き込む
   * loadDocument 後に呼ぶ
   */
  writeCellTiles(cellId: string, tiles: { tx: number; ty: number; data: Uint16Array }[]): void {
    if (!findCell(this.rootNodes, cellId)) return;
    for (const { tx, ty, data } of tiles) {
      const index = ty * this.tileStore.tilesX + tx;
      this.tileStore.writeTileData(cellId, index, data);
    }
    this.syncNonEmpty(cellId);
    this.markCellDirty(cellId);
    this.maintainTiles();
    this.invalidate();
  }

  // --- ブラシ・スナップショット系（アクティブレイヤー対象）---

  updateBrushConfig(config: Partial<BrushConfig>): void {
    this.brushRenderer.updateConfig(config);
    // リボン筆が使うサブセットをミラーする（色・点色・透明保護・筆圧濃度・混色）
    const ribbonSubset: Partial<import('./ribbon.js').RibbonConfig> = {};
    if (config.color !== undefined) ribbonSubset.color = { ...config.color };
    if (config.usePointColor !== undefined) ribbonSubset.usePointColor = config.usePointColor;
    if (config.alphaLock !== undefined) ribbonSubset.alphaLock = config.alphaLock;
    if (config.pressureOpacity !== undefined) ribbonSubset.pressureOpacity = config.pressureOpacity;
    if (config.wetRatio !== undefined) ribbonSubset.wetRatio = config.wetRatio;
    if (config.mixMode !== undefined) ribbonSubset.mixMode = config.mixMode;
    if (Object.keys(ribbonSubset).length > 0) this.ribbonRenderer.updateConfig(ribbonSubset);
  }

  async requestCommittedSnapshot() {
    if (!this.activeCellId) throw new Error('No active cell');
    return this.readbackTexture(this.ensureComposed(this.activeCellId));
  }

  /** 全レイヤー合成結果（リニア・プリマルチ）の CPU 読み出し（スポイト用） */
  async requestCompositeSnapshot() {
    this.ensureCachesClean();
    return this.readbackTexture(this.displayCache);
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
   * T1: 基準は履歴 owner のタイル集合。committed へ深複製する（基準は redo 用に残す）
   */
  rebakeFromRecords(records: StrokeRecord[]): void {
    if (!this.activeCellId) return;
    const baseOwner = RenderPipeline.historyOwner(this.activeCellId);
    const hasBase = this.tileStore.getOccupancy(baseOwner).size > 0;
    // committed を一旦破棄し、基準があれば深複製する。
    // 旧占有も汚す（再生で触れないタイルの残像を消すため）
    const oldOcc = new Set(this.tileStore.getOccupancy(this.activeCellId));
    this.tileStore.releaseCell(this.activeCellId);
    if (hasBase) {
      this.tileStore.copyOwner(baseOwner, this.activeCellId);
    }
    this.markTilesDirty([...oldOcc, ...this.tileStore.getOccupancy(this.activeCellId)]);
    const currentPressureOpacity = this.brushRenderer.getConfig().pressureOpacity;
    const savedRibbonMode = this.ribbonMode;
    this.brushRenderer.updateConfig({ usePointColor: true });
    this.ribbonRenderer.updateConfig({ usePointColor: true });
    for (const rec of records) {
      if (rec.kind === 'fill') {
        // fill スナップショットは全面画像。ゼロ走査で正確に採用する
        this.tileStore.adoptData(this.activeCellId, rec.snapshot, rec.bytesPerRow / 2, this.canvasWidth, this.canvasHeight);
        this.syncNonEmpty(this.activeCellId);
      } else if (rec.points.length > 0) {
        // レコードの筆種で再現（混在時は都度切替）
        this.ribbonMode = (rec.brushKind ?? 'stamp') === 'ribbon';
        // レコードに保存した alphaLock で再現（描画順は元と同じなのでマスクも一致）
        this.brushRenderer.updateConfig({ pressureOpacity: rec.pressureOpacity ?? false });
        this.ribbonRenderer.updateConfig({ pressureOpacity: rec.pressureOpacity ?? false });
        this.beginIncrementalStroke(rec.alphaLock ?? false);
        // 巨大な1ストロークも固定点数の局所bboxへ分けて再生する。
        for (let i = 0; i < rec.points.length; i += 4096) {
          this.appendIncrementalStroke(rec.points.slice(i, i + 4096));
        }
        this.finishIncrementalStroke([], rec.erase);
      }
    }
    this.brushRenderer.updateConfig({ usePointColor: false, pressureOpacity: currentPressureOpacity });
    this.ribbonRenderer.updateConfig({ usePointColor: false, pressureOpacity: currentPressureOpacity });
    this.ribbonMode = savedRibbonMode;
    if (this.activeCellId) {
      this.syncNonEmpty(this.activeCellId);
    }
    this.invalidate();
  }

  /**
   * Undo 上限から押し出された1操作を、履歴 owner のタイルへ焼き込む。
   * 呼び出し後は StrokeRecord（特に長い points 配列）を保持する必要がない。
   */
  appendHistoryBaseRecord(cellId: string, record: StrokeRecord): void {
    const baseOwner = RenderPipeline.historyOwner(cellId);

    if (record.kind === 'fill') {
      this.tileStore.adoptData(baseOwner, record.snapshot, record.bytesPerRow / 2, this.canvasWidth, this.canvasHeight);
      return;
    }
    if (record.points.length === 0) return;

    const savedConfig = this.brushRenderer.getConfig();
    const savedStroke = this.currentStroke;
    const savedAccum = this.hasStrokeAccum;
    const savedAccumBBox = this.strokeAccumBBox;
    const savedAlphaLock = this.drawAlphaLock;
    const savedRibbonMode = this.ribbonMode;
    if (record.kind === 'stroke') this.ribbonMode = (record.brushKind ?? 'stamp') === 'ribbon';
    this.currentStroke = [];
    this.hasStrokeAccum = false;
    this.strokeAccumBBox = null;
    this.drawAlphaLock = record.alphaLock ?? false;
    this.clearTextureContent(this.strokeAccumTexture);
    this.brushRenderer.updateConfig({
      usePointColor: true,
      pressureOpacity: record.pressureOpacity ?? false,
    });
    // alphaLock 参照は履歴基準の合成ビュー
    const baseView = this.ensureComposed(baseOwner);
    for (let i = 0; i < record.points.length; i += 4096) {
      if (this.ribbonMode) {
        this.drawRibbonToIsolated(record.points.slice(i, i + 4096), baseView);
      } else {
        this.drawToIsolated(record.points.slice(i, i + 4096), baseView);
      }
      this.compositeRenderer.mergeMax(this.isolatedTexture, this.strokeAccumTexture);
      this.absorbAccumBounds(record.points.slice(i, i + 4096));
    }
    this.bakeFullscreenToTiles(baseOwner, this.strokeAccumTexture, record.erase ? 'erase' : 'over', this.tilesForBounds(this.strokeAccumBBox));
    this.brushRenderer.updateConfig(savedConfig);
    this.ribbonMode = savedRibbonMode;
    this.currentStroke = savedStroke;
    this.hasStrokeAccum = savedAccum;
    this.strokeAccumBBox = savedAccumBBox;
    this.drawAlphaLock = savedAlphaLock;
  }

  /** 履歴全消去時に、Undo対象外の基準画像も破棄する。 */
  clearHistoryBase(cellId: string): void {
    this.tileStore.releaseCell(RenderPipeline.historyOwner(cellId));
  }

  /**
   * 全面 CPU 画像をアクティブセルの占有タイルへ書き込む（cancel 復元用）。
   * shape は変わらない前提。data は aligned 可（bytesPerRow 指定）。
   */
  restoreCommittedSnapshot(data: Uint16Array, bytesPerRow: number): void {
    if (!this.activeCellId) return;
    const w = this.canvasWidth, h = this.canvasHeight;
    const stride = bytesPerRow / 2;
    this.tileStore.scatterData(this.activeCellId, this.tileStore.getOccupancy(this.activeCellId), data, stride, w, h);
    this.syncNonEmpty(this.activeCellId);
    this.invalidate();
  }

  /**
   * 全面 CPU 画像から採用（バケツ塗り用）。ゼロ走査で占有を正確に作り直す。
   * data は aligned 可（bytesPerRow 指定）。
   */
  adoptPaintResult(data: Uint16Array, bytesPerRow: number): void {
    if (!this.activeCellId) return;
    this.tileStore.adoptData(this.activeCellId, data, bytesPerRow / 2, this.canvasWidth, this.canvasHeight);
    this.syncNonEmpty(this.activeCellId);
    this.markCellDirty(this.activeCellId);
    this.maintainTiles();
    this.invalidate();
  }

  /** アクティブレイヤーをクリア */
  clear() {
    this.currentStroke = [];
    this.hasStrokeAccum = false;
    this.strokeAccumBBox = null;
    if (this.activeCellId) {
      this.markCellDirty(this.activeCellId);
      this.tileStore.releaseCell(this.activeCellId);
      this.clearHistoryBase(this.activeCellId);
      this.nonEmptyCells.delete(this.activeCellId);
    }
    this.invalidate();
  }

  resizeCanvasSize(w: number, h: number) {
    // リサイズ前に変形・移動操作があればキャンセル
    if (this.txActive) this.cancelTransform();
    if (this.moveActive) this.cancelMove();
    this.brushRenderer.resize(w * 4, h * 4);
    this.ribbonRenderer.resize(w, h);
    this.brushBboxTexture?.destroy();
    this.brushBboxTexture = null;
    this.brushBboxSize = { w: 0, h: 0 };
    this.isolatedTexture.destroy();
    this.strokeAccumTexture.destroy();
    this.liveCombinedTexture.destroy();
    this.baseCache.destroy(); this.displayCache.destroy();
    this.compA.destroy(); this.compB.destroy();
    this.activeComposite.destroy();
    this.filterScratch.destroy();
    this.cellProcTemp.destroy();
    this.composeScratch.destroy();
    this.previewTexture.destroy();
    this.createTextures(w, h);
    this.filterRenderer.resize(w, h);
    this.invalidate();
  }

  resizeScreenSize(w: number, h: number) {
    this.renderer.canvas.width = w;
    this.renderer.canvas.height = h;
    this.invalidate();
  }

  /**
   * 全レイヤーを合成した結果を PNG としてエクスポート
   */
  async exportToPNG(): Promise<Blob> {
    const { device } = this.renderer;
    const width = this.canvasWidth;
    const height = this.canvasHeight;
    const bytesPerRow = Math.ceil(width * 8 / 256) * 256;

    // 現在ストロークなしで全レイヤーを合成（キャッシュ経由）
    this.ensureCachesClean();
    const result = this.displayCache;

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
    this.ribbonRenderer.dispose();
    this.transformRenderer.dispose();
    this.filterRenderer.dispose();
    this.tileBaker.dispose();
    this._clearTransformState();
    this._clearMoveState();
    this.brushBboxTexture?.destroy();
    this.isolatedTexture?.destroy();
    this.strokeAccumTexture?.destroy();
    this.liveCombinedTexture?.destroy();
    this.baseCache?.destroy(); this.displayCache?.destroy();
    this.compA?.destroy(); this.compB?.destroy();
    this.activeComposite?.destroy();
    this.filterScratch?.destroy();
    this.cellProcTemp?.destroy();
    this.composeScratch?.destroy();
    this.previewTexture?.destroy();
    this.blankTile?.destroy();
    this.destroyAllCellTextures();
  }

  /** 移動状態のクリア（dispose 用。履歴には触れない） */
  private _clearMoveState(): void {
    this.moveActive = false;
    this.moveSnapshot = null;
    this.moveBase = null;
    this.moveContent = null;
    this.moveResult = null;
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
