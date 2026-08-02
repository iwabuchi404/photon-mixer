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
import {
  type LayerNode, type FolderNode, type CellNode, type EffectChainItem,
  findNode, findCell, findParent, flattenCells, visibleCells, findEffect,
  createCell, createFolder, createEffect, removeNode, moveNode,
} from './layer-model.js';
import { linearToDisplaySrgb, TONEMAP_IDS, DISPLAY_MODE_IDS, type TonemapId, type DisplayModeId } from '../color/display.js';

const BUFFER_FORMAT: GPUTextureFormat = 'rgba16float';

// レイヤーモデルの型を再エクスポート（旧API互換用）
export type { LayerNode, FolderNode, CellNode, EffectChainItem } from './layer-model.js';

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
  private cellProcTemp!: GPUTexture;    // セル効果チェーン処理用（ping-pong）

  // 3オブジェクト構造: レイヤーツリー + ルート効果チェーン（撮影スタック）
  private rootNodes: LayerNode[] = [];
  private rootEffects: EffectChainItem[] = [];
  private activeCellId: string | null = null;
  // セルID → committed テクスチャのマップ（実行時データ）
  private cellTextures: Map<string, GPUTexture> = new Map();

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

  // アクティブセルの committed テクスチャ（既存の描画系メソッドが参照する）
  private get committedTexture(): GPUTexture {
    if (!this.activeCellId) throw new Error('No active cell');
    const tex = this.cellTextures.get(this.activeCellId);
    if (!tex) throw new Error(`Active cell ${this.activeCellId} has no texture`);
    return tex;
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
    // セル効果チェーン処理用のテクスチャ（ping-pong）
    this.cellProcTemp = this.renderer.device.createTexture({
      size: [width, height], format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // レイヤーを初期化（1枚のセル）
    this.destroyAllCellTextures();
    this.rootNodes = [this.createCellWithTexture('レイヤー 1')];
    this.rootEffects = [];
    this.activeCellId = this.rootNodes[0].id;
  }

  private destroyAllCellTextures(): void {
    for (const tex of this.cellTextures.values()) tex.destroy();
    this.cellTextures.clear();
  }

  /** セルを作成し committed テクスチャを割り当てる */
  private createCellWithTexture(name: string): CellNode {
    const cell = createCell(name);
    this.cellTextures.set(cell.id, this.makeLayerTexture());
    return cell;
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
      this.drawAlphaLock = this.getActiveLayerAlphaLock();
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
   * 3オブジェクト構造: セルを積み順に合成 → ルート効果チェーンを適用
   * @param includeLiveStroke true ならアクティブセルに現在ストロークを重ねる
   */
  private compositeLayers(includeLiveStroke: boolean, transparentBg = false): GPUTexture {
    const { device } = this.renderer;

    // アクティブセルのソース（現在ストロークを焼き込んだ一時テクスチャ）
    let activeSrc: GPUTexture | null = null;
    if (includeLiveStroke && this.currentStroke.length > 0 && this.activeCellId) {
      const activeCell = findCell(this.rootNodes, this.activeCellId);
      if (activeCell) {
        this.drawAlphaLock = activeCell.alphaLock;
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
    }

    // ping-pong 合成。acc を背景色（or 透明）にクリアして下から重ねる
    if (transparentBg) this.clearTextureContent(this.displayA);
    else this.clearToBackground(this.displayA);
    let acc = this.displayA;
    let other = this.displayB;

    // セルを積み順に合成（フォルダの表示状態を考慮）
    const cells = visibleCells(this.rootNodes);
    for (const cell of cells) {
      if (cell.opacity <= 0) continue;
      // セルの committed テクスチャを取得
      const committed = this.cellTextures.get(cell.id);
      if (!committed) continue;

      // セルの効果チェーンを適用（効果がある場合）
      let src: GPUTexture = committed;
      if (cell.effects.length > 0) {
        src = this.applyCellEffects(cell, committed, activeSrc && cell.id === this.activeCellId ? activeSrc : null);
      } else if (cell.id === this.activeCellId && activeSrc) {
        src = activeSrc;
      }

      this.blendRenderer.blend(acc, src, other, cell.blendMode, cell.opacity);
      const tmp = acc; acc = other; other = tmp;
    }

    // ルート効果チェーン（撮影スタック）を適用
    for (const eff of this.rootEffects) {
      if (!eff.visible || eff.opacity <= 0) continue;
      if (eff.filterType === 'curve' && eff.curvePoints) {
        this.filterRenderer.setCurveLut(buildCurveLut(eff.curvePoints));
      }
      // acc に効果を適用して other へ
      this.filterRenderer.apply(eff.filterType, eff.params, acc, null, other, eff.opacity);
      const tmp = acc; acc = other; other = tmp;
    }

    return acc;
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

  // --- レイヤー操作（3オブジェクト構造） ---

  /** レイヤーツリーを取得（UI用） */
  getRootNodes(): LayerNode[] {
    return this.rootNodes;
  }

  /** ルート効果チェーン（撮影スタック）を取得（UI用） */
  getRootEffects(): EffectChainItem[] {
    return this.rootEffects;
  }

  /** セルのcommittedテクスチャを取得（UIのプレビュー等用） */
  getCellTexture(cellId: string): GPUTexture | null {
    return this.cellTextures.get(cellId) ?? null;
  }

  setLayerAlphaLock(id: string, locked: boolean): void {
    const cell = findCell(this.rootNodes, id);
    if (cell) cell.alphaLock = locked;
  }

  // --- 効果チェーン ---

  /** 効果をセルの効果チェーンに追加 */
  addEffectToCell(cellId: string, type: FilterType): string {
    const cell = findCell(this.rootNodes, cellId);
    if (!cell) throw new Error(`Cell ${cellId} not found`);
    const eff = createEffect(type);
    cell.effects.push(eff);
    return eff.id;
  }

  /** 効果をルート効果チェーン（撮影スタック）に追加 */
  addEffectToRoot(type: FilterType): string {
    const eff = createEffect(type);
    this.rootEffects.push(eff);
    return eff.id;
  }

  /** 効果のパラメータを更新 */
  setEffectParams(id: string, params: Partial<FilterParams>): void {
    const found = findEffect(this.rootNodes, this.rootEffects, id);
    if (found) found.effect.params = { ...found.effect.params, ...params };
  }

  /** 効果(curve)の制御点を更新 */
  setEffectCurve(id: string, points: CurvePoint[]): void {
    const found = findEffect(this.rootNodes, this.rootEffects, id);
    if (found) found.effect.curvePoints = points.map(p => ({ ...p }));
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
    if (rootIdx >= 0) { this.rootEffects.splice(rootIdx, 1); return; }
    // セルの効果チェーンから削除
    const walk = (nodes: LayerNode[]): boolean => {
      for (const n of nodes) {
        if (n.kind === 'cell') {
          const idx = n.effects.findIndex(e => e.id === id);
          if (idx >= 0) { n.effects.splice(idx, 1); return true; }
        } else if (n.kind === 'folder') {
          if (walk(n.children)) return true;
        }
      }
      return false;
    };
    walk(this.rootNodes);
  }

  /** 効果の表示/非表示を切り替え */
  setEffectVisible(id: string, visible: boolean): void {
    const found = findEffect(this.rootNodes, this.rootEffects, id);
    if (found) found.effect.visible = visible;
  }

  /**
   * Freeze: セルの効果チェーン全体をセルのcommittedに焼き込む。
   * 効果チェーンをクリアし、committed を処理結果で置き換える。
   */
  freezeCellEffects(cellId: string): void {
    const cell = findCell(this.rootNodes, cellId);
    if (!cell || cell.effects.length === 0) return;
    const committed = this.cellTextures.get(cellId);
    if (!committed) return;
    // 効果チェーンを適用した結果を新しいテクスチャに書き出す
    const result = this.applyCellEffects(cell, committed, null);
    const baked = this.makeLayerTexture();
    const enc = this.renderer.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: result }, { texture: baked }, [this.canvasWidth, this.canvasHeight]);
    this.renderer.device.queue.submit([enc.finish()]);
    // committed を破棄して baked に置き換え
    committed.destroy();
    this.cellTextures.set(cellId, baked);
    cell.effects = [];
  }

  /**
   * Freeze: ルート効果チェーン全体を全セル合成結果に焼き込む。
   * 全セルを1枚に統合し、ルート効果を適用した結果を単一セルに置換する。
   */
  freezeRootEffects(): void {
    if (this.rootEffects.length === 0) return;
    // 全セル合成（透明下地）+ ルート効果適用
    const result = this.compositeLayers(false, true);
    const baked = this.makeLayerTexture();
    const enc = this.renderer.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: result }, { texture: baked }, [this.canvasWidth, this.canvasHeight]);
    this.renderer.device.queue.submit([enc.finish()]);
    // 全セルを破棄して単一セルに置換
    this.destroyAllCellTextures();
    const cell = createCell('統合レイヤー');
    this.cellTextures.set(cell.id, baked);
    this.rootNodes = [cell];
    this.rootEffects = [];
    this.activeCellId = cell.id;
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
    if (cell) this.activeCellId = id;
  }

  /** セルを追加（アクティブセルのルートレベルの上に挿入） */
  addLayer(): string {
    const cell = this.createCellWithTexture(`レイヤー ${flattenCells(this.rootNodes).length + 1}`);
    // アクティブセルと同じ親の子として、その上に挿入
    const parent = this.activeCellId ? findParent(this.rootNodes, this.activeCellId) : null;
    if (parent) {
      parent.parent.splice(parent.index + 1, 0, cell);
    } else {
      this.rootNodes.push(cell);
    }
    this.activeCellId = cell.id;
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
    // アクティブセルのテクスチャを破棄
    const tex = this.cellTextures.get(this.activeCellId);
    if (tex) { tex.destroy(); this.cellTextures.delete(this.activeCellId); }
    // ツリーから削除
    removeNode(this.rootNodes, this.activeCellId);
    // 新しいアクティブセルを選択
    const remaining = flattenCells(this.rootNodes);
    this.activeCellId = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
  }

  /** 指定IDのノードを削除（セル or フォルダ） */
  removeNode(id: string): void {
    if (id === this.activeCellId) { this.removeActiveLayer(); return; }
    // セルの場合、テクスチャを破棄
    const cell = findCell(this.rootNodes, id);
    if (cell) {
      const tex = this.cellTextures.get(id);
      if (tex) { tex.destroy(); this.cellTextures.delete(id); }
    }
    removeNode(this.rootNodes, id);
  }

  moveActiveLayer(dir: 'up' | 'down'): void {
    if (!this.activeCellId) return;
    moveNode(this.rootNodes, this.activeCellId, dir);
  }

  /** 指定IDのノードを上下に移動 */
  moveNode(id: string, dir: 'up' | 'down'): void {
    moveNode(this.rootNodes, id, dir);
  }

  setLayerVisible(id: string, visible: boolean): void {
    const node = findNode(this.rootNodes, id);
    if (node) node.visible = visible;
  }

  setLayerOpacity(id: string, opacity: number): void {
    const cell = findCell(this.rootNodes, id);
    if (cell) cell.opacity = opacity;
  }

  setLayerBlendMode(id: string, mode: BlendMode): void {
    const cell = findCell(this.rootNodes, id);
    if (cell) cell.blendMode = mode;
  }

  /** フォルダの折りたたみ状態を切り替え */
  setFolderCollapsed(id: string, collapsed: boolean): void {
    const node = findNode(this.rootNodes, id);
    if (node && node.kind === 'folder') node.collapsed = collapsed;
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
   * 全セルのピクセルデータ（tight packed float16 RGBA）を読み出す
   * .pmx 保存用
   */
  async readAllCells(): Promise<{ cell: CellNode; data: Uint16Array }[]> {
    const { device } = this.renderer;
    const w = this.canvasWidth, h = this.canvasHeight;
    const bytesPerRow = Math.ceil(w * 8 / 256) * 256;
    const alignedU16 = bytesPerRow / 2;

    const cells = flattenCells(this.rootNodes);
    const out: { cell: CellNode; data: Uint16Array }[] = [];
    for (const cell of cells) {
      const committed = this.cellTextures.get(cell.id);
      if (!committed) continue;
      const staging = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: committed }, { buffer: staging, bytesPerRow }, [w, h]);
      device.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const aligned = new Uint16Array(staging.getMappedRange());
      // 256アライン → tight（width*4 u16/row）に詰め直す
      const tight = new Uint16Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        tight.set(aligned.subarray(y * alignedU16, y * alignedU16 + w * 4), y * w * 4);
      }
      staging.unmap(); staging.destroy();
      out.push({ cell, data: tight });
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
    // 新しいツリーを構築 + テクスチャ確保
    this.rootNodes = nodes;
    this.rootEffects = rootEffects;
    // 全セルのテクスチャを作成
    for (const cell of flattenCells(nodes)) {
      this.cellTextures.set(cell.id, this.makeLayerTexture());
    }
    if (flattenCells(this.rootNodes).length === 0) {
      const cell = this.createCellWithTexture('レイヤー 1');
      this.rootNodes = [cell];
    }
    this.activeCellId = activeId || flattenCells(this.rootNodes)[0]?.id || null;
  }

  /**
   * .pmx 読込: セルのピクセルデータをテクスチャに書き込む
   * loadDocument 後に呼ぶ
   */
  writeCellData(cellId: string, data: Uint16Array): void {
    const tex = this.cellTextures.get(cellId);
    if (tex) this.writeLayerTight(tex, data);
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
    const currentPressureOpacity = this.brushRenderer.getConfig().pressureOpacity;
    this.brushRenderer.updateConfig({ usePointColor: true });
    for (const rec of records) {
      if (rec.kind === 'fill') {
        this.updateCommittedTexture(rec.snapshot);
      } else if (rec.points.length > 0) {
        // レコードに保存した alphaLock で再現（描画順は元と同じなのでマスクも一致）
        this.drawAlphaLock = rec.alphaLock ?? false;
        this.brushRenderer.updateConfig({ pressureOpacity: rec.pressureOpacity ?? false });
        this.drawToIsolated(rec.points);
        this.compositeRenderer.bake(this.isolatedTexture, this.committedTexture, rec.erase);
      }
    }
    this.brushRenderer.updateConfig({ usePointColor: false, pressureOpacity: currentPressureOpacity });
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
    this.cellProcTemp.destroy();
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
    this.cellProcTemp?.destroy();
    this.destroyAllCellTextures();
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
