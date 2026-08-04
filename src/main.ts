/**
 * PhotonMixer メインエントリーポイント
 */

import { initRenderer } from './core/renderer.js';
import { PenInputManager } from './pen/input.js';
import { StabilizationController } from './pen/stabilization-mode.js';
import { Interpolator } from './pen/interpolation.js';
import { LiveStrokeProcessor, type LiveStrokeUpdate } from './pen/live-stroke.js';
import { PostCorrector } from './pen/post-correction.js';
import { StrokeManager, StrokeHistory, type StrokeRecord } from './pen/stroke.js';
import { RenderPipeline } from './render/pipeline.js';
import type { LayerNode, CellNode, EffectChainItem } from './render/layer-model.js';
import { PerfMonitor } from './ui/perf-monitor.js';
import { Viewport } from './viewport.js';
import { srgbToLinear, linearColorToSrgb } from './color/linear.js';
import { linearToOklab, oklabToLinear, mixOklab } from './color/oklab.js';
import { BrushPresetManager } from './brush-preset.js';
import { savePmx, loadPmx } from './pmx.js';
import { saveAutosave, loadAutosave } from './autosave.js';
import { ColorPicker } from './ui/color-picker.js';
import { buildMaskContour } from './selection/mask.js';
import { createEngineCtx, type EngineCtx } from './ui/engine-ctx.js';
import type { Tool } from './ui/tool-config.js';
import './ui/components/tool-bar.js'; // customElements.define('pm-tool-bar') を実行（副作用 import・必須）
import type { ToolBar } from './ui/components/tool-bar.js';
import { TOOLS, PARAM_DEFS, getToolDef, type ParamKey } from './ui/tool-config.js';
import { ToolSettingsStore } from './ui/tool-settings.js';
import { evToExposure, linearToDisplaySrgb, type TonemapId, type DisplayModeId } from './color/display.js';
import type { FilterType, FilterParams } from './render/filter.js';
import { CurveEditor } from './ui/curve-editor.js';
import type { LinearColor } from './color/types.js';
import type { StrokePoint } from './pen/stroke.js';
import type { PointerPoint } from './pen/input.js';
import type { BrushConfig } from './render/brush.js';
import type { BrushMixMode } from './render/brush.js';
import { linearToSrgb } from './color/linear.js';

// Float32 → Float16 (Uint16) 変換
function float32ToFloat16(f: number): number {
  const buf = new ArrayBuffer(4);
  const f32 = new Float32Array(buf);
  const u32 = new Uint32Array(buf);
  f32[0] = f;
  const x = u32[0];
  const s = (x >> 16) & 0x8000;
  let e = ((x >> 23) & 0xFF) - (127 - 15);
  let m = x & 0x7FFFFF;
  if (e <= 0) {
    if (e < -10) return s;
    m = (m | 0x800000) >> (1 - e);
    return s | (m >> 13);
  } else if (e >= 31) return s | 0x7C00;
  return s | (e << 10) | (m >> 13);
}

// Float16（Uint16 表現）→ Float32 変換
// ... (略)
function float16ToFloat32(h: number): number {
  const sign = (h >> 15) & 1;
  const exp  = (h >> 10) & 0x1F;
  const frac =  h        & 0x3FF;
  if (exp === 0)  return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
  if (exp === 31) return frac === 0 ? (sign ? -Infinity : Infinity) : NaN;
  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

// committedSnapshot から指定キャンバス座標の色をサンプリング（最近傍）
function sampleSnapshot(
  data: Uint16Array,
  x: number, y: number,
  canvasWidth: number, canvasHeight: number,
  bytesPerRow: number,
): LinearColor {
  const px = Math.max(0, Math.min(canvasWidth  - 1, Math.round(x)));
  const py = Math.max(0, Math.min(canvasHeight - 1, Math.round(y)));
  const uint16sPerRow = bytesPerRow / 2;
  const idx = py * uint16sPerRow + px * 4;
  return {
    r: float16ToFloat32(data[idx]),
    g: float16ToFloat32(data[idx + 1]),
    b: float16ToFloat32(data[idx + 2]),
    a: float16ToFloat32(data[idx + 3]),
  };
}


interface AppState {
  isDrawing: boolean;
  currentColor: LinearColor;
  wetRatio: number;
  mixMode: BrushMixMode;
  currentTool: Tool;
  isPanning: boolean;
  useTexture: boolean;
  textureScale: number;
  bucketTolerance: number; // 0-1（塗りつぶし／自動選択の色差許容）
  selectMode: 'rect' | 'lasso' | 'wand'; // 選択ツールのモード
  pressureOpacity: boolean; // 筆圧で不透明度を反映
}

interface ProgressiveStrokeState {
  baseColor: LinearColor;
  smudge: LinearColor;
  prevX: number | null;
  prevY: number | null;
}

/** パラメータ → 対応するDOMコントロールのID（値の保存/復元に使う） */
const PARAM_CONTROLS: Record<ParamKey, { id: string; num?: string; val?: string }> = {
  size:         { id: 'brush-size', num: 'brush-size-num' },
  opacity:      { id: 'brush-alpha', val: 'brush-alpha-val' },
  pressureOpacity: { id: 'brush-pressure-opacity' },
  wet:          { id: 'brush-wet', val: 'brush-wet-val' },
  stabilize:    { id: 'brush-stabilize', val: 'brush-stabilize-val' },
  curve:        { id: 'pressure-curve' },
  mixMode:      { id: 'mix-mode' },
  textureScale: { id: 'texture-scale', val: 'texture-scale-val' },
  tolerance:    { id: 'bucket-tolerance', val: 'bucket-tolerance-val' },
};

/** パラメータを持たないツール向けの操作ヒント */
const TOOL_HINTS: Partial<Record<Tool, string>> = {
  spoit: 'クリックした位置の色を抽出します。',
  move: 'ドラッグでレイヤー（選択範囲があればその内側）を移動します。',
  transform: 'ハンドルで拡大縮小・回転。Enter で確定 / Esc で取消。',
};

class PhotonMixerApp {
  private renderer: Awaited<ReturnType<typeof initRenderer>> | null = null;
  private penInput: PenInputManager | null = null;
  private stabilizer: StabilizationController;
  private interpolator: Interpolator;
  private postCorrector: PostCorrector;
  private strokeManager: StrokeManager;
  private liveStrokeProcessor: LiveStrokeProcessor;
  // レイヤーごとの Undo 履歴（Undo はアクティブレイヤーに作用）
  private layerHistories = new Map<string, StrokeHistory>();
  private renderPipeline: RenderPipeline | null = null;
  private viewport: Viewport;
  private perfMonitor: PerfMonitor;
  // UI→エンジン反映の唯一の窓口（setupControls で生成）
  private engineCtx!: EngineCtx;
  // 左の縦ツールバー（Lit コンポーネント）
  private toolBar: ToolBar | null = null;
  // ツールごとのパラメータ個別状態（setupControls で生成）
  private toolSettings!: ToolSettingsStore;
  // 編集中の効果レイヤーID（null=効果を編集していない）
  private editingEffectId: string | null = null;
  // トーンカーブエディタ
  private curveEditor: CurveEditor | null = null;
  private state: AppState = {
    isDrawing: false,
    currentColor: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
    wetRatio: 0,
    mixMode: 'stamp',
    currentTool: 'brush',
    isPanning: false,
    useTexture: false,
    textureScale: 1.0,
    bucketTolerance: 0,
    selectMode: 'rect',
    pressureOpacity: false,
  };

  /** 分割フラッシュ済みの点列。Undo は従来どおり一筆単位で保持する。 */
  private liveStrokePoints: StrokePoint[] = [];
  private progressiveStrokeState: ProgressiveStrokeState | null = null;
  private prevTool: Tool | null = null;

  // テクスチャブラシの元画像（プリセット保存で再利用するため保持）
  private currentTextureBitmap: ImageBitmap | null = null;
  private colorPicker: ColorPicker | null = null;

  // 引きずり混色（progressive）用: pen-down 時の committed スナップショット
  private committedSnapshot: { data: Uint16Array; bytesPerRow: number } | null = null;

  constructor() {
    this.stabilizer = new StabilizationController({
      mode: 'ema',
      emaConfig: { threshold: 1000, minAlpha: 0.3 },
      pulledStringConfig: { radius: 8, finishLine: true },
    });
    // spacing=1: 4x バッファでダウンサンプルするため 1px でも GPU 負荷は低く品質が高い
    // 半透明ブラシで点線にならないためスタンプを密に配置する
    this.interpolator = new Interpolator({ spacing: 1, speedThreshold: 2000 });
    this.postCorrector = new PostCorrector(this.interpolator);
    this.strokeManager = new StrokeManager({ baseSize: 2, maxSize: 20, curve: 'linear' });
    this.liveStrokeProcessor = new LiveStrokeProcessor(this.stabilizer, this.interpolator);
    this.viewport = new Viewport();
    this.perfMonitor = new PerfMonitor();
  }

  async init(): Promise<void> {
    console.log('PhotonMixer initializing...');

    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    if (!canvas) throw new Error('Canvas element not found');

    // 画面サイズに追従（キャンバスではなく描画領域）
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // 選択オーバーレイも画面サイズに合わせる
    const overlay = document.getElementById('selection-overlay') as HTMLCanvasElement | null;
    if (overlay) { overlay.width = window.innerWidth; overlay.height = window.innerHeight; }

    try {
      this.renderer = await initRenderer(canvas);
      console.log('WebGPU initialized successfully');
    } catch (e) {
      console.error('Failed to initialize WebGPU:', e);
      alert('WebGPUの初期化に失敗しました。');
      return;
    }

    this.renderPipeline = new RenderPipeline(this.renderer);
    await this.renderPipeline.init();

    this.penInput = new PenInputManager(canvas);
    this.penInput.onPenInput((event) => this.handlePenInput(event));

    window.addEventListener('resize', () => this.handleResize());
    // アイドル時は描画を止めるため、OSの再表示・復帰時だけ明示的に再描画する。
    window.addEventListener('focus', () => this.renderPipeline?.invalidate());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.renderPipeline?.invalidate();
    });

    this.setupControls();
    this.setupInteractions();
    
    // ダイアログ表示
    const modal = document.getElementById('new-canvas-modal')!;
    const createBtn = document.getElementById('create-canvas-btn')!;
    const inputW = document.getElementById('canvas-w') as HTMLInputElement;
    const inputH = document.getElementById('canvas-h') as HTMLInputElement;

    createBtn.addEventListener('click', () => {
      const w = parseInt(inputW.value) || 2000;
      const h = parseInt(inputH.value) || 2000;
      this.createNewCanvas(w, h);
      modal.style.display = 'none';
      this.startRenderLoop();
      this.startAutosave();
    });

    // 自動保存の復元提案（前回作業があれば）
    try {
      const auto = await loadAutosave();
      if (auto) {
        const when = new Date(auto.savedAt).toLocaleString();
        if (confirm(`前回の作業（${when}）が見つかりました。復元しますか？`)) {
          const file = new File([auto.blob], 'autosave.pmx');
          await this.openPmxFile(file);
          modal.style.display = 'none';
          this.startRenderLoop();
          this.startAutosave();
        }
      }
    } catch (e) {
      // 自動保存スロットが無い/未初期化でも致命的ではない
      console.log('autosave restore skipped:', (e as Error)?.message ?? e);
    }

    // Electron アプリメニューからのアクションを受信
    this.setupMenuActions();

    console.log('PhotonMixer initialized (waiting for canvas creation)');
  }

  /**
   * Electron メニュー → IPC → レンダラー のアクションディスパッチャ。
   * 既存メソッドへ振り分ける。ブラウザ単体動作時は未接続で何もしない。
   */
  private setupMenuActions(): void {
    const api = (window as any).electronAPI as
      | { onMenuAction?: (cb: (msg: { action: string; payload?: string }) => void) => (() => void) | undefined }
      | undefined;
    if (!api?.onMenuAction) return; // ブラウザ単体時など未公開なら無視
    api.onMenuAction((msg) => this.handleMenuAction(msg));
  }

  private handleMenuAction(msg: { action: string; payload?: string }): void {
    switch (msg.action) {
      // ---- ファイル ----
      case 'file:new':
        this.showNewCanvasModal();
        break;
      case 'file:open':
        (document.getElementById('pmx-file-input') as HTMLInputElement | null)?.click();
        break;
      case 'file:save-pmx':
        this.savePmxFile();
        break;
      case 'file:export-png':
        document.getElementById('export-png-btn')?.dispatchEvent(new Event('click'));
        break;

      // ---- 編集 ----
      case 'edit:undo':
        if (this.activeHistory().undo()) this.renderPipeline?.rebakeFromRecords(this.activeHistory().getAllRecords());
        break;
      case 'edit:redo':
        if (this.activeHistory().redo()) this.renderPipeline?.rebakeFromRecords(this.activeHistory().getAllRecords());
        break;
      case 'edit:clear-canvas':
        this.renderPipeline?.clear();
        this.activeHistory().clear();
        break;

      // ---- 選択 ----
      case 'select:all':
        this.selectAll();
        break;
      case 'select:invert':
        this.invertSelectionUI();
        break;
      case 'select:deselect':
        this.clearSelectionUI();
        break;

      // ---- レイヤー ----
      case 'layer:add':
        this.renderPipeline?.addLayer();
        this.rebuildLayerPanel();
        this.refreshEffectEdit();
        break;
      case 'layer:add-folder':
        this.renderPipeline?.addFolder();
        this.rebuildLayerPanel();
        break;
      case 'layer:delete': {
        const id = this.renderPipeline?.getActiveLayerId();
        this.renderPipeline?.removeActiveLayer();
        if (id) this.layerHistories.delete(id);
        this.rebuildLayerPanel();
        this.refreshEffectEdit();
        break;
      }
      case 'layer:move-up':
        this.renderPipeline?.moveActiveLayer('up');
        this.rebuildLayerPanel();
        break;
      case 'layer:move-down':
        this.renderPipeline?.moveActiveLayer('down');
        this.rebuildLayerPanel();
        break;

      // ---- エフェクト ----
      case 'effect:add':
        if (msg.payload) this.addEffect(msg.payload as FilterType);
        break;
      case 'effect:freeze':
        this.freezeEffect();
        break;

      // ---- 表示 ----
      case 'view:zoom-in':
        this.zoomBy(1.25);
        break;
      case 'view:zoom-out':
        this.zoomBy(1 / 1.25);
        break;
      case 'view:zoom-reset':
        this.zoomTo(1.0);
        break;
      case 'view:reset-rotation':
        this.viewport.resetRotation();
        this.applyViewport();
        break;
      case 'view:toggle-flip':
        this.viewport.toggleFlip();
        this.applyViewport();
        break;
      case 'view:toggle-ui':
        this.toggleUI();
        break;
      case 'view:ev-up':
        this.adjustExposureEV(+0.5);
        break;
      case 'view:ev-down':
        this.adjustExposureEV(-0.5);
        break;
      case 'view:ev-reset':
        this.adjustExposureEV(null, 0);
        break;
      case 'view:tonemap':
        if (msg.payload) this.setTonemap(msg.payload as TonemapId);
        break;
      case 'view:mode':
        if (msg.payload) this.setDisplayMode(msg.payload as DisplayModeId);
        break;

      // ---- ツール ----
      case 'tool:set':
        if (msg.payload) this.setTool(msg.payload as Tool);
        break;

      // ---- ヘルプ ----
      case 'help:about':
        alert('PhotonMixer v0.1.1\nWebGPUネイティブ・浮動小数点リニアカラーのデジタルイラストソフトウェア\n\nMIT License');
        break;
    }
  }

  /** 新規キャンバス作成モーダルを再表示する */
  private showNewCanvasModal(): void {
    const modal = document.getElementById('new-canvas-modal');
    if (modal) modal.style.display = 'block';
  }

  /** ズームを現在位置を中心に倍率変更（メニュー/ショートカット用） */
  private zoomBy(factor: number): void {
    this.viewport.zoom(factor, window.innerWidth / 2, window.innerHeight / 2);
    this.applyViewport();
    this.updateZoomDisplay();
  }

  /** ズーム倍率を直接指定（画面中心） */
  private zoomTo(scale: number): void {
    const t = this.viewport.getTransform();
    // 画面中心を維持してスケール変更
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const ratio = scale / t.scale;
    this.viewport.zoom(ratio, cx, cy);
    this.applyViewport();
    this.updateZoomDisplay();
  }

  /** 露出EV を増減、または絶対値リセット（delta=null で value を設定） */
  private adjustExposureEV(delta: number | null, value?: number): void {
    const exp = document.getElementById('view-exposure') as HTMLInputElement | null;
    if (!exp) return;
    if (delta === null) {
      exp.value = String(value ?? 0);
    } else {
      exp.value = String(parseFloat(exp.value) + delta);
    }
    exp.dispatchEvent(new Event('input'));
  }

  /** トーンマップを切り替え（UIの select と同期） */
  private setTonemap(id: TonemapId): void {
    const sel = document.getElementById('view-tonemap') as HTMLSelectElement | null;
    if (sel) {
      sel.value = id;
      sel.dispatchEvent(new Event('change'));
    }
  }

  /** 表示モードを切り替え（UIの select と同期） */
  private setDisplayMode(id: DisplayModeId): void {
    const sel = document.getElementById('view-mode') as HTMLSelectElement | null;
    if (sel) {
      sel.value = id;
      sel.dispatchEvent(new Event('change'));
    }
  }

  /**
   * 自動保存ループ（一定間隔で現在のプロジェクトを IndexedDB に退避）
   */
  private autosaveTimer: number | null = null;
  private startAutosave(): void {
    if (this.autosaveTimer !== null) return;
    const INTERVAL = 3 * 60 * 1000; // 3分
    this.autosaveTimer = window.setInterval(async () => {
      if (!this.renderPipeline) return;
      try {
        const { width, height } = this.renderPipeline.getCanvasSize();
        const cellData = await this.renderPipeline.readAllCells();
        const blob = savePmx(
          width, height,
          this.renderPipeline.getRootNodes(),
          this.renderPipeline.getRootEffects(),
          cellData.map(({ cell, data }) => ({ cellId: cell.id, data })),
          this.renderPipeline.getActiveLayerId(),
          { documentSettings: { view: this.currentViewSettings(), swatches: this.colorPicker?.getSwatches() ?? [] } },
        );
        await saveAutosave(blob);
      } catch (e) {
        console.warn('autosave failed:', e);
      }
    }, INTERVAL);
  }

  private createNewCanvas(width: number, height: number): void {
    if (!this.renderPipeline) return;
    this.renderPipeline.resizeCanvasSize(width, height);
    this.viewport.reset(width, height, window.innerWidth, window.innerHeight);
    const transform = this.viewport.getTransform();
    this.renderPipeline.updateViewport(transform.scale, transform.offsetX, transform.offsetY, transform.rotation, transform.flip);
    this.layerHistories.clear();
    this.clearSelectionUI(); // 旧キャンバスサイズの選択マスクを破棄
    this.rebuildLayerPanel();
    this.updateZoomDisplay();
  }

  /**
   * アクティブレイヤーの Undo 履歴を取得（なければ作成）
   */
  private activeHistory(): StrokeHistory {
    const id = this.renderPipeline!.getActiveLayerId();
    let h = this.layerHistories.get(id);
    if (!h) { h = new StrokeHistory(); this.layerHistories.set(id, h); }
    return h;
  }

  /** 履歴追加と、Undo上限を超えた操作のGPUラスターチェックポイント化を一体で行う。 */
  private addHistoryRecord(record: StrokeRecord): void {
    if (!this.renderPipeline) return;
    const cellId = this.renderPipeline.getActiveLayerId();
    const evicted = this.activeHistory().addRecord(record);
    if (evicted && cellId) this.renderPipeline.appendHistoryBaseRecord(cellId, evicted);
  }

  /**
   * レイヤーパネルを現在の状態から再構築する（3オブジェクト構造・26px行デザイン）
   * ツリーを再帰的に表示。上が前面になるよう逆順で表示。
   * ブレンドモード・不透明度は選択セルの共有ストリップで編集（行には表示しない）
   */
  private rebuildLayerPanel(): void {
    const list = document.getElementById('layer-list');
    if (!list || !this.renderPipeline) return;
    const nodes = this.renderPipeline.getRootNodes();
    const activeId = this.renderPipeline.getActiveLayerId();

    list.innerHTML = '';
    // 前面（配列末尾）が上に来るよう逆順で表示
    const renderNodes = (nodeList: LayerNode[], depth: number) => {
      for (let i = nodeList.length - 1; i >= 0; i--) {
        const node = nodeList[i];
        const row = document.createElement('div');
        row.className = 'layer-row' + (node.kind === 'folder' ? ' folder-row' : '');
        row.style.paddingLeft = `${6 + depth * 14}px`;
        if (node.id === activeId) row.classList.add('active');

        if (node.kind === 'folder') {
          // フォルダ行: 畳み展开 + 表示 + 名前
          const collapse = document.createElement('span');
          collapse.className = 'collapse-arrow';
          collapse.textContent = node.collapsed ? '▸' : '▾';
          collapse.addEventListener('click', (e) => {
            e.stopPropagation();
            this.renderPipeline?.setFolderCollapsed(node.id, !node.collapsed);
            this.rebuildLayerPanel();
          });
          const eye = document.createElement('span');
          eye.className = 'layer-eye' + (node.visible ? '' : ' hidden');
          eye.textContent = node.visible ? '◉' : '○';
          eye.addEventListener('click', (e) => {
            e.stopPropagation();
            this.renderPipeline?.setLayerVisible(node.id, !node.visible);
            this.rebuildLayerPanel();
          });
          const nameEl = document.createElement('span');
          nameEl.className = 'layer-name';
          nameEl.textContent = node.name;
          row.appendChild(collapse);
          row.appendChild(eye);
          row.appendChild(nameEl);
          list.appendChild(row);
          if (!node.collapsed) {
            renderNodes(node.children, depth + 1);
          }
        } else {
          // セル行: 表示 + 名前 + アルファロック + 不透明度帯
          // 不透明度の帯（行背景右側にオレンジの幅で表現）
          const band = document.createElement('div');
          band.className = 'opacity-band';
          band.style.width = `${Math.round(node.opacity * 100)}%`;
          row.appendChild(band);

          const eye = document.createElement('span');
          eye.className = 'layer-eye' + (node.visible ? '' : ' hidden');
          eye.textContent = node.visible ? '◉' : '○';
          eye.addEventListener('click', (e) => {
            e.stopPropagation();
            this.renderPipeline?.setLayerVisible(node.id, !node.visible);
            this.rebuildLayerPanel();
          });
          const nameEl = document.createElement('span');
          nameEl.className = 'layer-name';
          nameEl.textContent = node.name;
          const lock = document.createElement('span');
          lock.className = 'layer-lock' + (node.alphaLock ? ' on' : '');
          lock.textContent = node.alphaLock ? '🔒' : '🔓';
          lock.title = '透明部分を保護';
          lock.addEventListener('click', (e) => {
            e.stopPropagation();
            this.renderPipeline?.setLayerAlphaLock(node.id, !node.alphaLock);
            this.rebuildLayerPanel();
          });
          row.appendChild(eye);
          row.appendChild(nameEl);
          row.appendChild(lock);
          row.addEventListener('click', () => {
            this.renderPipeline?.setActiveLayer(node.id);
            this.rebuildLayerPanel();
            this.refreshEffectEdit();
          });
          list.appendChild(row);
        }
      }
    };
    renderNodes(nodes, 0);

    // 選択セルの共有ストリップ（ブレンドモード + 不透明度）を更新
    this.updateActiveStrip();
    // 効果チェーンパネルも更新
    this.rebuildEffectChainPanel();
  }

  /** 選択セルの共有ストリップ（ブレンドモード + 不透明度）を更新 */
  private updateActiveStrip(): void {
    const strip = document.getElementById('layer-active-strip');
    if (!strip || !this.renderPipeline) return;
    const activeId = this.renderPipeline.getActiveLayerId();
    if (!activeId) { strip.style.display = 'none'; return; }
    // アクティブセルを検索
    const nodes = this.renderPipeline.getRootNodes();
    const findCell = (list: LayerNode[]): CellNode | null => {
      for (const n of list) {
        if (n.kind === 'cell' && n.id === activeId) return n;
        if (n.kind === 'folder') { const c = findCell(n.children); if (c) return c; }
      }
      return null;
    };
    const cell = findCell(nodes);
    if (!cell) { strip.style.display = 'none'; return; }
    strip.style.display = '';
    const blendSel = document.getElementById('strip-blend-mode') as HTMLSelectElement;
    const opSlider = document.getElementById('strip-opacity') as HTMLInputElement;
    const opVal = document.getElementById('strip-opacity-val');
    if (blendSel) {
      blendSel.value = cell.blendMode;
      blendSel.onchange = () => {
        this.renderPipeline?.setLayerBlendMode(activeId, blendSel.value as any);
        this.rebuildLayerPanel();
      };
    }
    if (opSlider && opVal) {
      opSlider.value = Math.round(cell.opacity * 100).toString();
      opVal.textContent = String(Math.round(cell.opacity * 100));
      opSlider.oninput = () => {
        const v = parseInt(opSlider.value) / 100;
        this.renderPipeline?.setLayerOpacity(activeId, v);
        // 行の帯を即時更新（パネル再構築なしで）
        const band = document.querySelector('.layer-row.active .opacity-band') as HTMLElement;
        if (band) band.style.width = `${Math.round(v * 100)}%`;
        opVal.textContent = String(Math.round(v * 100));
      };
    }
  }

  /** 効果チェーンパネルを再構築 */
  private effectTab: 'cell' | 'root' = 'cell';
  private rebuildEffectChainPanel(): void {
    const list = document.getElementById('effect-chain-list');
    if (!list || !this.renderPipeline) return;
    list.innerHTML = '';
    let effects: EffectChainItem[];
    if (this.effectTab === 'root') {
      effects = this.renderPipeline.getRootEffects();
    } else {
      const activeId = this.renderPipeline.getActiveLayerId();
      if (!activeId) { return; }
      const nodes = this.renderPipeline.getRootNodes();
      const findCell = (list: LayerNode[]): CellNode | null => {
        for (const n of list) {
          if (n.kind === 'cell' && n.id === activeId) return n;
          if (n.kind === 'folder') { const c = findCell(n.children); if (c) return c; }
        }
        return null;
      };
      const cell = findCell(nodes);
      effects = cell?.effects ?? [];
    }
    for (const eff of effects) {
      const row = document.createElement('div');
      row.className = 'effect-chain-row' + (eff.id === this.editingEffectId ? ' active' : '');
      const eye = document.createElement('span');
      eye.className = 'eff-eye';
      eye.textContent = eff.visible ? '◉' : '○';
      eye.style.color = eff.visible ? '' : 'var(--pm-text-faint)';
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        this.renderPipeline?.setEffectVisible(eff.id, !eff.visible);
        this.rebuildEffectChainPanel();
      });
      const nameEl = document.createElement('span');
      nameEl.className = 'eff-name';
      nameEl.textContent = eff.name;
      const del = document.createElement('span');
      del.className = 'eff-del';
      del.textContent = '×';
      del.title = '効果を削除';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.renderPipeline?.removeEffect(eff.id);
        if (this.editingEffectId === eff.id) this.editingEffectId = null;
        this.rebuildEffectChainPanel();
        this.refreshEffectEdit();
      });
      row.appendChild(eye);
      row.appendChild(nameEl);
      row.appendChild(del);
      row.addEventListener('click', () => {
        this.editingEffectId = eff.id;
        this.rebuildEffectChainPanel();
        this.refreshEffectEdit();
      });
      list.appendChild(row);
    }
  }

  /**
   * 現在の全レイヤーを .pmx として保存
   */
  private async savePmxFile(): Promise<void> {
    if (!this.renderPipeline) return;
    try {
      const { width, height } = this.renderPipeline.getCanvasSize();
      const cellData = await this.renderPipeline.readAllCells();
      const activeId = this.renderPipeline.getActiveLayerId();
      const blob = savePmx(
        width, height,
        this.renderPipeline.getRootNodes(),
        this.renderPipeline.getRootEffects(),
        cellData.map(({ cell, data }) => ({ cellId: cell.id, data })),
        activeId,
        { documentSettings: { view: this.currentViewSettings(), swatches: this.colorPicker?.getSwatches() ?? [] } },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `photonmixer_${Date.now()}.pmx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to save .pmx:', e);
      alert('.pmx の保存に失敗しました。');
    }
  }

  /**
   * .pmx を読み込んで全レイヤーを復元
   */
  private async openPmxFile(file: File): Promise<void> {
    if (!this.renderPipeline) return;
    try {
      const { width, height, activeCellId, rootNodes, rootEffects, cellData, documentSettings } = await loadPmx(file);
      this.renderPipeline.loadDocument(width, height, rootNodes, rootEffects, activeCellId);
      // セルのピクセルデータをテクスチャに書き込む
      for (const { cellId, data } of cellData) {
        this.renderPipeline.writeCellData(cellId, data);
      }
      // View 設定・スウォッチを復元
      if (documentSettings) {
        this.applyViewSettings(documentSettings.view);
        this.colorPicker?.setSwatches(documentSettings.swatches as any);
      }
      // ビューポートを作り直したキャンバスに合わせて再配置
      this.viewport.reset(width, height, window.innerWidth, window.innerHeight);
      const t = this.viewport.getTransform();
      this.renderPipeline.updateViewport(t.scale, t.offsetX, t.offsetY, t.rotation, t.flip);
      // 履歴はピクセルから復元できないためクリア（読込後の Undo は不可）
      this.layerHistories.clear();
      this.rebuildLayerPanel();
      this.refreshEffectEdit();
      this.updateZoomDisplay();
    } catch (e) {
      console.error('Failed to open .pmx:', e);
      alert('.pmx の読み込みに失敗しました。');
    }
  }

  private updateZoomDisplay(): void {
    const zoomVal = document.getElementById('zoom-val');
    if (zoomVal) {
      zoomVal.textContent = Math.round(this.viewport.getTransform().scale * 100).toString();
    }
  }

  /** 現在のビューポート状態をパイプラインへ反映 */
  private applyViewport(): void {
    const t = this.viewport.getTransform();
    this.renderPipeline?.updateViewport(t.scale, t.offsetX, t.offsetY, t.rotation, t.flip);
    this.drawSelectionOverlay();
  }

  /** UI パネルの表示/非表示をトグル（Tab） */
  private uiHidden = false;
  private toggleUI(): void {
    this.uiHidden = !this.uiHidden;
    const display = this.uiHidden ? 'none' : '';
    for (const id of ['brush-controls', 'layer-panel', 'perf-monitor']) {
      const el = document.getElementById(id);
      if (el) el.style.display = display;
    }
  }

  /** ブラシサイズを delta だけ増減（[ ] ショートカット用） */
  private adjustBrushSize(delta: number): void {
    const slider = document.getElementById('brush-size') as HTMLInputElement;
    const num = document.getElementById('brush-size-num') as HTMLInputElement;
    const next = Math.max(1, Math.min(100, parseInt(slider.value) + delta));
    slider.value = next.toString();
    num.value = next.toString();
    const baseSize = Math.max(1, Math.round(next * 0.1));
    this.strokeManager.updatePressureConfig({ maxSize: next, baseSize });
  }

  private isProgressiveMixing(): boolean {
    return this.state.mixMode === 'progressive' && this.state.wetRatio > 0;
  }

  /** 引きずり混色 or ぼかし筆（どちらも smudge ベースの点ごとの色処理を使う） */
  private usesSmudge(): boolean {
    return this.isProgressiveMixing() || this.state.currentTool === 'blur';
  }

  // 直線ツール用：始点（キャンバス座標）
  private lineStart: { x: number; y: number } | null = null;
  // Shift 押下状態（直線の角度スナップ用）
  private shiftDown = false;

  // --- 変形ツール用 ---
  private txStarting = false;   // beginTransform 非同期待ち
  private txActive = false;     // 変形操作中
  // 変形パラメータ（bounds 中心を変形中心として使用）
  private txBounds: { lx: number; ty: number; rx: number; by: number } | null = null;
  private txSx = 1;     // x スケール
  private txSy = 1;     // y スケール
  private txTheta = 0;  // 回転角（ラジアン）
  private txTx = 0;     // x 平行移動（キャンバス座標）
  private txTy = 0;     // y 平行移動（キャンバス座標）
  // ドラッグ中のハンドル（0-7: スケール, 8: 回転, 9: 全体平行移動, -1: なし）
  private txHandleIndex = -1;
  private txDragOrigin: { x: number; y: number; sx: number; sy: number; theta: number; tx: number; ty: number; dist: number; angle: number } | null = null;

  // --- 移動ツール用 ---
  private isMoveActive = false;   // beginMove が完了して移動中
  private moveStarting = false;   // beginMove の非同期待ち中
  private moveOrigin: { x: number; y: number } | null = null; // down 時のキャンバス座標

  // --- 選択ツール用 ---
  private isSelecting = false;
  private selectAnchor: { x: number; y: number } | null = null;  // 矩形始点（キャンバス座標）
  private selectCurrent: { x: number; y: number } | null = null; // 矩形現在点（キャンバス座標）
  // 投げ縄ドラッグ中の頂点列（キャンバス座標）
  private lassoPoints: { x: number; y: number }[] | null = null;
  // 確定済み選択範囲の輪郭（キャンバス座標の線分列 [x0,y0,x1,y1,...]）。null=選択なし
  private selectionSegments: number[] | null = null;

  private handlePenInput(event: import('./pen/input.js').PenInputEvent): void {
    if (this.state.isPanning) return;

    const { type, point } = event;

    // スクリーン座標 -> キャンバス座標
    const { x, y } = this.viewport.toCanvas(point.x, point.y);
    const transformedPoint = { ...point, x, y };

    switch (type) {
      case 'down': {
        if (this.state.currentTool === 'transform') {
          if (this.txStarting || !this.txActive) return; // beginTransform 待ち or 未開始
          const handles = this.getTransformHandles();
          const hitIdx = this.hitTestHandle(point.x, point.y, handles);
          // 変形中心のスクリーン座標
          const b = this.txBounds!;
          const cx = (b.lx + b.rx) / 2 + this.txTx;
          const cy = (b.ty + b.by) / 2 + this.txTy;
          const center = this.viewport.toScreen(cx, cy);
          const ddx = point.x - center.x, ddy = point.y - center.y;
          this.txHandleIndex = hitIdx;
          this.txDragOrigin = {
            x: point.x, y: point.y,
            sx: this.txSx, sy: this.txSy,
            theta: this.txTheta, tx: this.txTx, ty: this.txTy,
            dist: Math.hypot(ddx, ddy),
            angle: Math.atan2(ddy, ddx),
          };
          return;
        }
        if (this.state.currentTool === 'move') {
          // beginMove は非同期（GPU→CPU 読み出し）なのでフラグで待ち状態を管理
          this.moveStarting = true;
          this.renderPipeline?.beginMove().then(() => {
            this.isMoveActive = true;
            this.moveStarting = false;
            this.moveOrigin = { x: transformedPoint.x, y: transformedPoint.y };
          });
          return;
        }
        if (this.state.currentTool === 'select') {
          if (this.state.selectMode === 'wand') {
            // 自動選択：クリック地点の連結同色領域を選択（非同期）
            this.renderPipeline?.setMagicWandSelection(transformedPoint.x, transformedPoint.y, this.state.bucketTolerance)
              .then(() => this.refreshSelectionContour());
            return;
          }
          if (this.state.selectMode === 'lasso') {
            this.isSelecting = true;
            this.lassoPoints = [{ x: transformedPoint.x, y: transformedPoint.y }];
            return;
          }
          // 矩形選択：始点をキャンバス座標で記録
          this.isSelecting = true;
          this.selectAnchor = { x: transformedPoint.x, y: transformedPoint.y };
          this.selectCurrent = { x: transformedPoint.x, y: transformedPoint.y };
          return;
        }
        if (this.state.currentTool === 'spoit') {
          this.handleSpoit(transformedPoint.x, transformedPoint.y);
          return;
        }
        if (this.state.currentTool === 'bucket') {
          this.handleBucketFill(transformedPoint.x, transformedPoint.y);
          return;
        }
        if (this.state.currentTool === 'line') {
          this.state.isDrawing = true;
          this.lineStart = { x: transformedPoint.x, y: transformedPoint.y };
          return;
        }

        this.state.isDrawing = true;
        this.liveStrokePoints = [];
        const initialUpdate = this.liveStrokeProcessor.begin(transformedPoint);
        this.renderPipeline?.beginIncrementalStroke();

        // 消しゴムモードならパイプライン切り替え
        this.renderPipeline?.setEraseMode(this.state.currentTool === 'eraser');

        if (this.usesSmudge()) {
          // 点ごとの色を使うモードに切り替えてスナップショットを非同期取得
          this.renderPipeline?.updateBrushConfig({ usePointColor: true });
          this.progressiveStrokeState = {
            baseColor: { ...this.state.currentColor },
            smudge: { ...this.state.currentColor },
            prevX: null,
            prevY: null,
          };
          this.committedSnapshot = null;
          this.renderPipeline?.requestCommittedSnapshot().then(snap => {
            this.committedSnapshot = snap;
          });
          this.handleProgressiveUpdate(initialUpdate);
        } else {
          this.progressiveStrokeState = null;
          this.handleStampUpdate(initialUpdate);
        }
        break;
      }

      case 'move': {
        if (this.state.currentTool === 'transform') {
          if (!this.txActive || !this.txDragOrigin || !this.txBounds) return;
          const b = this.txBounds;
          const cx = (b.lx + b.rx) / 2, cy = (b.ty + b.by) / 2;
          const centerScreen = this.viewport.toScreen(cx + this.txTx, cy + this.txTy);
          const ddx = point.x - centerScreen.x, ddy = point.y - centerScreen.y;
          const idx = this.txHandleIndex;

          if (idx === 8) {
            // 回転ハンドル
            this.txTheta = this.txDragOrigin.theta + (Math.atan2(ddy, ddx) - this.txDragOrigin.angle);
          } else if (idx % 2 === 0 && idx >= 0 && idx <= 7) {
            // コーナーハンドル: 等比スケール（中心からの距離比）
            const d1 = Math.hypot(ddx, ddy);
            const factor = d1 / (this.txDragOrigin.dist || 1);
            this.txSx = Math.max(0.05, this.txDragOrigin.sx * factor);
            this.txSy = Math.max(0.05, this.txDragOrigin.sy * factor);
          } else if (idx === 1 || idx === 5) {
            // 上/下辺中点: y スケール
            const d1 = Math.abs(ddy);
            const factor = d1 / (Math.abs(this.txDragOrigin.dist) || 1);
            this.txSy = Math.max(0.05, this.txDragOrigin.sy * factor);
          } else if (idx === 3 || idx === 7) {
            // 右/左辺中点: x スケール
            const d1 = Math.abs(ddx);
            const factor = d1 / (Math.abs(this.txDragOrigin.dist) || 1);
            this.txSx = Math.max(0.05, this.txDragOrigin.sx * factor);
          } else {
            // ハンドル外 or idx=-1: 全体平行移動
            // スクリーン差をキャンバス差に変換（スケールのみ考慮、回転は省略でOK）
            const scale = this.viewport.getTransform().scale;
            this.txTx = this.txDragOrigin.tx + (point.x - this.txDragOrigin.x) / scale;
            this.txTy = this.txDragOrigin.ty + (point.y - this.txDragOrigin.y) / scale;
          }

          this.renderPipeline?.updateTransform(this.buildInvMatrix());
          this.drawTransformOverlay();
          return;
        }
        if (this.state.currentTool === 'move') {
          if (!this.isMoveActive || !this.moveOrigin) return;
          const dx = transformedPoint.x - this.moveOrigin.x;
          const dy = transformedPoint.y - this.moveOrigin.y;
          this.renderPipeline?.applyMoveOffset(dx, dy);
          return;
        }
        if (this.state.currentTool === 'select') {
          if (!this.isSelecting) return;
          if (this.state.selectMode === 'lasso' && this.lassoPoints) {
            this.lassoPoints.push({ x: transformedPoint.x, y: transformedPoint.y });
          } else {
            this.selectCurrent = { x: transformedPoint.x, y: transformedPoint.y };
          }
          this.drawSelectionOverlay();
          return;
        }
        if (!this.state.isDrawing) return;
        if (this.state.currentTool === 'line') {
          this.renderPipeline?.setCurrentStroke(this.buildLineStroke(transformedPoint.x, transformedPoint.y));
          return;
        }
        const update = this.liveStrokeProcessor.add(transformedPoint);
        if (this.usesSmudge()) {
          this.handleProgressiveUpdate(update);
        } else {
          this.handleStampUpdate(update);
        }

        const inputId = this.perfMonitor.recordInput();
        this.perfMonitor.recordRender(inputId);
        break;
      }

      case 'up': {
        if (this.state.currentTool === 'transform') {
          this.txHandleIndex = -1;
          this.txDragOrigin = null;
          return;
        }
        if (this.state.currentTool === 'move') {
          if (this.moveStarting) {
            // beginMove がまだ完了していない場合はキャンセル扱い
            this.moveStarting = false;
            this.renderPipeline?.cancelMove();
            return;
          }
          if (!this.isMoveActive) return;
          const moved = this.renderPipeline?.commitMove();
          if (moved) {
            this.addHistoryRecord({ kind: 'fill', snapshot: moved.snapshot, bytesPerRow: moved.bytesPerRow });
          }
          this.isMoveActive = false;
          this.moveOrigin = null;
          return;
        }
        if (this.state.currentTool === 'select') {
          if (!this.isSelecting) return;
          this.isSelecting = false;
          if (this.state.selectMode === 'lasso') {
            const pts = this.lassoPoints;
            this.lassoPoints = null;
            if (pts && pts.length >= 3) {
              this.renderPipeline?.setLassoSelection(pts);
              this.refreshSelectionContour();
            } else {
              this.clearSelectionUI();
            }
            return;
          }
          const a = this.selectAnchor, b = this.selectCurrent;
          this.selectAnchor = null;
          this.selectCurrent = null;
          if (!a || !b) return;
          // クリックのみ（ドラッグ量が小さい）＝選択解除
          if (Math.abs(a.x - b.x) < 2 || Math.abs(a.y - b.y) < 2) {
            this.clearSelectionUI();
          } else {
            this.renderPipeline?.setRectSelection(a.x, a.y, b.x, b.y);
            this.refreshSelectionContour();
          }
          return;
        }
        if (!this.state.isDrawing) return;

        if (this.state.currentTool === 'line') {
          const line = this.buildLineStroke(transformedPoint.x, transformedPoint.y);
          if (line.length > 0) {
            this.bakeColorIntoPoints(line);
            this.renderPipeline?.commitStroke(line);
            this.addHistoryRecord({
              kind: 'stroke', points: line, erase: false,
              alphaLock: this.renderPipeline?.getActiveLayerAlphaLock() ?? false,
              pressureOpacity: this.state.pressureOpacity,
            });
          }
          this.renderPipeline?.setCurrentStroke([]);
          this.lineStart = null;
          this.state.isDrawing = false;
          return;
        }

        // pointerup位置も確定ストロークへ含める。moveの最終サンプルと離れている場合、
        // ここを落とすと強い補正ほど線がペン位置の手前で終わってしまう。
        const lastRaw = this.liveStrokeProcessor.getLastRaw();
        if (!lastRaw || Math.hypot(
          transformedPoint.x - lastRaw.x,
          transformedPoint.y - lastRaw.y,
        ) > 0.01) {
          const update = this.liveStrokeProcessor.add(transformedPoint);
          if (this.usesSmudge()) this.handleProgressiveUpdate(update);
          else this.handleStampUpdate(update);
        }

        const erase = this.state.currentTool === 'eraser';
        const finishTransform = this.postCorrector.getConfig().enabled
          ? (points: PointerPoint[]) => this.postCorrector.correct(points)
          : undefined;
        const remaining = this.liveStrokeProcessor.finish(finishTransform);
        if (this.usesSmudge()) {
          const colored = this.strokeManager.finalizeStroke(remaining);
          if (this.progressiveStrokeState) {
            this.colorizeProgressivePoints(colored, this.progressiveStrokeState);
          }
          this.liveStrokePoints.push(...colored);
          this.renderPipeline?.finishIncrementalStroke(colored, erase);
          if (this.liveStrokePoints.length > 0) {
            this.addHistoryRecord({
              kind: 'stroke', points: this.liveStrokePoints, erase,
              alphaLock: this.renderPipeline?.getActiveLayerAlphaLock() ?? false,
              pressureOpacity: this.state.pressureOpacity,
            });
          }
          // 点ごとの色モードを解除
          this.renderPipeline?.updateBrushConfig({ usePointColor: false });
        } else {
          const finalTail = this.strokeManager.finalizeStroke(remaining);
          this.bakeColorIntoPoints(finalTail);
          this.liveStrokePoints.push(...finalTail);
          this.renderPipeline?.finishIncrementalStroke(finalTail, erase);
          if (this.liveStrokePoints.length > 0) {
            // rebake 時に色を忠実に再現するため、各点に現在のブラシ色を焼き込む
            this.addHistoryRecord({
              kind: 'stroke', points: this.liveStrokePoints, erase,
              alphaLock: this.renderPipeline?.getActiveLayerAlphaLock() ?? false,
              pressureOpacity: this.state.pressureOpacity,
            });
          }
        }

        this.committedSnapshot = null;
        this.progressiveStrokeState = null;
        this.state.isDrawing = false;
        this.liveStrokePoints = [];
        break;
      }
    }
  }

  /**
   * キーボード・マウス操作の設定
   */
  private setupInteractions(): void {
    const canvas = this.renderer!.canvas;

    // ホイール操作（ズーム or 回転）
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.altKey) {
        // Alt + ホイールで回転
        const delta = e.deltaY > 0 ? 0.05 : -0.05; // ラジアン
        this.viewport.rotate(delta);
      } else {
        // ホイールのみでズーム
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        this.viewport.zoom(factor, e.clientX, e.clientY);
      }
      const transform = this.viewport.getTransform();
      this.renderPipeline?.updateViewport(transform.scale, transform.offsetX, transform.offsetY, transform.rotation, transform.flip);
      this.updateZoomDisplay();
      this.drawSelectionOverlay();
    }, { passive: false });

    // パン操作 (Space + ドラッグ)
    let lastX = 0;
    let lastY = 0;

    window.addEventListener('keydown', (e) => {
      // 入力欄フォーカス中はショートカットを抑制（誤発火防止）
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      // --- Ctrl 系 ---
      if (e.ctrlKey) {
        if (e.key === 'z') {
          e.preventDefault();
          if (this.activeHistory().undo()) this.renderPipeline?.rebakeFromRecords(this.activeHistory().getAllRecords());
          return;
        }
        if (e.key === 'y' || (e.shiftKey && e.key === 'Z')) {
          e.preventDefault();
          if (this.activeHistory().redo()) this.renderPipeline?.rebakeFromRecords(this.activeHistory().getAllRecords());
          return;
        }
        if (e.shiftKey && (e.key === 'S' || e.key === 's')) { // Ctrl+Shift+S: PNG
          e.preventDefault();
          document.getElementById('export-png-btn')?.dispatchEvent(new Event('click'));
          return;
        }
        if (e.key === 's') { // Ctrl+S: .pmx 保存
          e.preventDefault();
          this.savePmxFile();
          return;
        }
        return; // 他の Ctrl 組み合わせはブラウザに任せる
      }

      // --- 単キー ---
      if (e.code === 'Space') {
        this.state.isPanning = true;
        canvas.style.cursor = 'grab';
        return;
      }
      if (e.key === 'Shift') this.shiftDown = true;
      switch (e.key) {
        case 'b': this.setTool('brush'); break;
        case 'e': this.setTool('eraser'); break;
        case 'i': this.setTool('spoit'); break;
        case 'g': this.setTool('bucket'); break;
        case 'u': this.setTool('blur'); break;
        case 'v': this.setTool('line'); break;
        case 'm': this.setTool('select'); break;
        case 'w': this.setTool('move'); break;
        case 't': this.setTool('transform'); break;
        case '[': this.adjustBrushSize(-2); break;
        case ']': this.adjustBrushSize(+2); break;
        case 'h': // 左右反転
          this.viewport.toggleFlip();
          this.applyViewport();
          break;
        case 'r': // 回転リセット
          e.preventDefault();
          this.viewport.resetRotation();
          this.applyViewport();
          break;
        case 'Tab': // UIパネルの表示/非表示
          e.preventDefault();
          this.toggleUI();
          break;
        case 'Enter': // 変形確定
          if (this.state.currentTool === 'transform' && this.txActive) {
            e.preventDefault();
            this.commitTransformUI();
          }
          break;
        case 'Escape': // 変形キャンセル
          if (this.state.currentTool === 'transform') {
            e.preventDefault();
            this.cancelTransformUI();
          }
          break;
      }
      if (e.key === 'Alt') {
        e.preventDefault();
        this.prevTool = this.state.currentTool;
        this.setTool('spoit');
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.state.isPanning = false;
        this.applyToolCursor(); // パン解除後はツールに応じたカーソルへ戻す
      }
      if (e.key === 'Shift') this.shiftDown = false;
      if (e.key === 'Alt' && this.prevTool) {
        this.setTool(this.prevTool);
        this.prevTool = null;
      }
    });

    canvas.addEventListener('mousedown', (e) => {
      lastX = e.clientX;
      lastY = e.clientY;
    });

    window.addEventListener('mousemove', (e) => {
      if (this.state.isPanning && (e.buttons & 1 || e.buttons & 4)) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        this.viewport.pan(dx, dy);
        const transform = this.viewport.getTransform();
        this.renderPipeline?.updateViewport(transform.scale, transform.offsetX, transform.offsetY, transform.rotation, transform.flip);
        lastX = e.clientX;
        lastY = e.clientY;
        this.drawSelectionOverlay();
      }
      this.updateBrushCursor(e.clientX, e.clientY, true);
    });

    // カーソルがウィンドウ外/UI上に出たら隠す
    window.addEventListener('mouseout', () => this.updateBrushCursor(0, 0, false));
  }

  /**
   * ブラシカーソル（円）を画面位置に追従させる
   * 半径 = ブラシ径 × ズーム倍率（画面上の実寸）
   */
  private updateBrushCursor(sx: number, sy: number, visible: boolean): void {
    const el = document.getElementById('brush-cursor');
    if (!el) return;
    // パン中やスポイト/バケツ時は非表示（描画系ツールのみ表示）
    const drawing = this.state.currentTool === 'brush' || this.state.currentTool === 'eraser';
    if (!visible || this.state.isPanning || !drawing) {
      el.style.display = 'none';
      return;
    }
    const size = this.strokeManager.getPressureConfig().maxSize;
    const diameter = size * this.viewport.getTransform().scale;
    el.style.width = `${diameter}px`;
    el.style.height = `${diameter}px`;
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
    el.style.display = 'block';
  }

  // ツールごとのネイティブカーソル（移動などの編集ツールでも形状で判別できるように）
  private static readonly TOOL_CURSORS: Record<Tool, string> = {
    brush: 'crosshair', eraser: 'crosshair', blur: 'crosshair', line: 'crosshair',
    spoit: 'crosshair', bucket: 'crosshair', select: 'crosshair',
    move: 'move', transform: 'move',
  };

  /** 現在のツールに応じてキャンバスのカーソル形状を設定する */
  private applyToolCursor(): void {
    const canvas = this.renderer?.canvas;
    if (!canvas) return;
    // パン中は手のひら（grab）を優先
    if (this.state.isPanning) { canvas.style.cursor = 'grab'; return; }
    canvas.style.cursor = PhotonMixerApp.TOOL_CURSORS[this.state.currentTool] ?? 'crosshair';
  }

  /**
   * オーバーレイを描画。変形中は変形ハンドル、それ以外は選択範囲（ライブプレビュー
   * または確定済み輪郭）を描く。すべてスクリーン座標へ変換するのでズーム/回転/反転に追従。
   */
  private drawSelectionOverlay(): void {
    const cv = document.getElementById('selection-overlay') as HTMLCanvasElement | null;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);

    // 変形中は変形ハンドルのみ
    if (this.txActive && this.txBounds) {
      this.drawTransformHandles(ctx);
      return;
    }

    // ライブプレビュー：矩形ドラッグ中
    if (this.isSelecting && this.state.selectMode === 'rect' && this.selectAnchor && this.selectCurrent) {
      const a = this.selectAnchor, b = this.selectCurrent;
      const c = [
        this.viewport.toScreen(a.x, a.y), this.viewport.toScreen(b.x, a.y),
        this.viewport.toScreen(b.x, b.y), this.viewport.toScreen(a.x, b.y),
      ];
      this.strokeMarchingAnts(ctx, () => {
        ctx.moveTo(c[0].x, c[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
        ctx.closePath();
      });
      return;
    }

    // ライブプレビュー：投げ縄ドラッグ中
    if (this.isSelecting && this.state.selectMode === 'lasso' && this.lassoPoints && this.lassoPoints.length > 1) {
      const pts = this.lassoPoints;
      this.strokeMarchingAnts(ctx, () => {
        const p0 = this.viewport.toScreen(pts[0].x, pts[0].y);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < pts.length; i++) {
          const p = this.viewport.toScreen(pts[i].x, pts[i].y);
          ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      });
      return;
    }

    // 確定済み選択範囲の輪郭（線分列）
    const seg = this.selectionSegments;
    if (seg && seg.length > 0) {
      this.strokeMarchingAnts(ctx, () => {
        for (let i = 0; i < seg.length; i += 4) {
          const p0 = this.viewport.toScreen(seg[i], seg[i + 1]);
          const p1 = this.viewport.toScreen(seg[i + 2], seg[i + 3]);
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
        }
      });
    }
  }

  /** 黒下地＋白点線でマーチングアント風に描く（背景色を問わず視認できる） */
  private strokeMarchingAnts(ctx: CanvasRenderingContext2D, buildPath: () => void): void {
    ctx.lineWidth = 1;
    ctx.beginPath(); buildPath();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** 選択解除（マスク破棄＋オーバーレイクリア） */
  private clearSelectionUI(): void {
    this.renderPipeline?.clearSelection();
    this.selectionSegments = null;
    this.drawSelectionOverlay();
  }

  /** 選択マスクから輪郭線分を再計算し、オーバーレイを更新する */
  private refreshSelectionContour(): void {
    const sel = this.renderPipeline?.getSelectionMaskData();
    this.selectionSegments = sel ? buildMaskContour(sel.data, sel.w, sel.h) : null;
    this.drawSelectionOverlay();
  }

  /** 選択モード切替（矩形/投げ縄/自動） */
  private setSelectMode(mode: 'rect' | 'lasso' | 'wand'): void {
    this.state.selectMode = mode;
    (['rect', 'lasso', 'wand'] as const).forEach(m => {
      document.getElementById(`select-mode-${m}`)?.classList.toggle('active', m === mode);
    });
  }

  /** 選択範囲を反転 */
  private invertSelectionUI(): void {
    this.renderPipeline?.invertSelection();
    this.refreshSelectionContour();
  }

  // ─────────────────────────────── 変形ツール ───────────────────────────────

  /**
   * 逆変換行列を計算（dst キャンバス座標 → src テクスチャ座標）
   * 結果は row-major 3x3 を array<vec4f,3> 形式の 12 floats で返す。
   */
  private buildInvMatrix(): Float32Array {
    const b = this.txBounds!;
    const cx = (b.lx + b.rx) / 2, cy = (b.ty + b.by) / 2;
    const cosT = Math.cos(this.txTheta), sinT = Math.sin(this.txTheta);
    const invSx = 1 / this.txSx, invSy = 1 / this.txSy;
    const dx = cx + this.txTx, dy = cy + this.txTy;
    // row 0: dst → src_u
    const r00 = cosT * invSx, r01 = sinT * invSx;
    const r02 = cx - b.lx - (cosT * dx + sinT * dy) * invSx;
    // row 1: dst → src_v
    const r10 = -sinT * invSy, r11 = cosT * invSy;
    const r12 = cy - b.ty - (-sinT * dx + cosT * dy) * invSy;
    return new Float32Array([r00, r01, r02, 0, r10, r11, r12, 0, 0, 0, 1, 0]);
  }

  /** 変形後のハンドル座標（スクリーン座標）を返す。最後の要素が回転ハンドル */
  private getTransformHandles(): { x: number; y: number }[] {
    if (!this.txBounds) return [];
    const { lx, ty, rx, by } = this.txBounds;
    const cx = (lx + rx) / 2, cy = (ty + by) / 2;
    const hw = (rx - lx) / 2, hh = (by - ty) / 2;
    const cosT = Math.cos(this.txTheta), sinT = Math.sin(this.txTheta);

    const applyForward = (px: number, py: number): { x: number; y: number } => {
      const lx2 = px - cx, ly2 = py - cy;
      const qx = cosT * this.txSx * lx2 - sinT * this.txSy * ly2 + cx + this.txTx;
      const qy = sinT * this.txSx * lx2 + cosT * this.txSy * ly2 + cy + this.txTy;
      return this.viewport.toScreen(qx, qy);
    };

    const pts = [
      applyForward(lx, ty),     applyForward(lx + hw, ty),  applyForward(rx, ty),
      applyForward(rx, ty + hh),
      applyForward(rx, by),     applyForward(lx + hw, by),  applyForward(lx, by),
      applyForward(lx, ty + hh),
    ];

    // 回転ハンドル: 上辺中点から外向き 28px
    const topL = pts[0], topR = pts[2];
    const edgeX = topR.x - topL.x, edgeY = topR.y - topL.y;
    const len = Math.hypot(edgeX, edgeY) || 1;
    const nx = -edgeY / len, ny = edgeX / len; // 上辺の外向き法線
    const topMid = pts[1];
    pts.push({ x: topMid.x + nx * 28, y: topMid.y + ny * 28 });

    return pts;
  }

  private hitTestHandle(sx: number, sy: number, handles: { x: number; y: number }[], r = 7): number {
    for (let i = 0; i < handles.length; i++) {
      const dx = sx - handles[i].x, dy = sy - handles[i].y;
      if (dx * dx + dy * dy <= r * r) return i;
    }
    return -1;
  }

  /** オーバーレイ全体を再描画（変形ハンドル含む）。drawSelectionOverlay に委譲 */
  private drawTransformOverlay(): void {
    this.drawSelectionOverlay();
  }

  /** 変形ハンドルと選択枠を描画（txActive 前提。クリアは呼び出し側） */
  private drawTransformHandles(ctx: CanvasRenderingContext2D): void {
    const handles = this.getTransformHandles();
    if (handles.length < 8) return;
    const corners = [handles[0], handles[2], handles[4], handles[6]];

    // 変形後の矩形枠（4隅を繋ぐ）
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.stroke();
    ctx.setLineDash([]);

    // 回転ハンドル〜上辺中点の線
    const rot = handles[8];
    ctx.beginPath();
    ctx.moveTo(handles[1].x, handles[1].y);
    ctx.lineTo(rot.x, rot.y);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.stroke();

    // ハンドル円（コーナー=白塗り, 辺中点=小円, 回転=∘）
    handles.forEach((h, i) => {
      ctx.beginPath();
      ctx.arc(h.x, h.y, i === 8 ? 5 : i % 2 === 0 ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === 8 ? 'rgba(80,200,255,0.9)' : 'rgba(255,255,255,0.95)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#000';
      ctx.stroke();
    });
  }

  /** 変形パラメータをリセットして pipeline に初期状態を反映 */
  private txResetParams(): void {
    this.txSx = 1; this.txSy = 1; this.txTheta = 0; this.txTx = 0; this.txTy = 0;
  }

  /** 変形確定 */
  private commitTransformUI(): void {
    if (!this.txActive) return;
    const result = this.renderPipeline?.commitTransform();
    if (result) {
      this.addHistoryRecord({ kind: 'fill', snapshot: result.snapshot, bytesPerRow: result.bytesPerRow });
    }
    this.txActive = false;
    this.txBounds = null;
    this.txHandleIndex = -1;
    this.txDragOrigin = null;
    this.drawTransformOverlay();
  }

  /** 変形キャンセル */
  private cancelTransformUI(): void {
    this.renderPipeline?.cancelTransform();
    this.txActive = false;
    this.txStarting = false;
    this.txBounds = null;
    this.txHandleIndex = -1;
    this.txDragOrigin = null;
    this.drawTransformOverlay();
  }

  // ──────────────────────────────────────────────────────────────────────────

  /** 全選択（キャンバス全体を選択範囲にする） */
  private selectAll(): void {
    const { width, height } = this.viewport.getCanvasSize();
    this.renderPipeline?.setRectSelection(0, 0, width, height);
    this.refreshSelectionContour();
  }

  private setTool(tool: Tool): void {
    const prev = this.state.currentTool;
    // move ツールから離脱時: キャンセル
    if (prev === 'move' && tool !== 'move') {
      if (this.isMoveActive) { this.renderPipeline?.cancelMove(); this.isMoveActive = false; this.moveOrigin = null; }
      this.moveStarting = false;
    }
    // transform ツールから離脱時: キャンセル
    if (prev === 'transform' && tool !== 'transform') {
      this.cancelTransformUI();
    }

    // 離脱するツールの現在値を保存（個別状態の保持）
    this.saveToolSettings(prev);

    this.state.currentTool = tool;
    this.applyToolCursor();
    this.toolBar?.setActive(tool);
    // ヘッダー・表示パラメータを更新し、ツールの保存値を復元してエンジンへ反映
    this.refreshToolOptions(tool);
    this.restoreToolSettings(tool);
    // 選択ツール時のみ全選択/解除・モード切替コントロールを表示
    const selCtrl = document.getElementById('select-controls');
    if (selCtrl) selCtrl.style.display = tool === 'select' ? '' : 'none';
    const selModeCtrl = document.getElementById('select-mode-controls');
    if (selModeCtrl) selModeCtrl.style.display = tool === 'select' ? '' : 'none';
    // 変形ツール時のみ確定/取消コントロールを表示
    const txCtrl = document.getElementById('transform-controls');
    if (txCtrl) txCtrl.style.display = tool === 'transform' ? '' : 'none';

    // transform ツール選択時: beginTransform を自動開始
    if (tool === 'transform') {
      this.txStarting = true;
      this.txResetParams();
      this.renderPipeline?.beginTransform().then(bounds => {
        if (!bounds || this.state.currentTool !== 'transform') return;
        this.txBounds = bounds;
        this.txActive = true;
        this.txStarting = false;
        this.renderPipeline?.updateTransform(this.buildInvMatrix());
        this.drawTransformOverlay();
      });
    }
  }

  /** 現在のツールの各パラメータをコントロールから読み取りストアへ保存 */
  private saveToolSettings(tool: Tool): void {
    for (const key of getToolDef(tool).params) {
      const el = document.getElementById(PARAM_CONTROLS[key].id) as HTMLInputElement | HTMLSelectElement | null;
      if (el) {
        const value = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
        this.toolSettings.set(tool, key, value);
      }
    }
  }

  /** ストアの値をコントロールへ復元し、エンジンへ反映（apply）する */
  private restoreToolSettings(tool: Tool): void {
    for (const key of getToolDef(tool).params) {
      const v = this.toolSettings.get(tool, key);
      if (v === undefined) continue;
      const ctrl = PARAM_CONTROLS[key];
      const el = document.getElementById(ctrl.id) as HTMLInputElement | HTMLSelectElement | null;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(v);
      else if (el) el.value = String(v);
      if (ctrl.num) {
        const n = document.getElementById(ctrl.num) as HTMLInputElement | null;
        if (n) n.value = String(v);
      }
      if (ctrl.val) {
        const s = document.getElementById(ctrl.val);
        if (s) s.textContent = String(v);
      }
      const def = PARAM_DEFS[key];
      const applyValue = def.kind === 'range' ? Number(v) : def.kind === 'checkbox' ? Boolean(v) : String(v);
      (def.apply as (val: number | string | boolean, e: EngineCtx) => void)(applyValue, this.engineCtx);
    }
  }

  /** ツールに応じてヘッダー・表示パラメータ・ヒント・テクスチャ操作を更新 */
  private refreshToolOptions(tool: Tool): void {
    const def = getToolDef(tool);
    const icon = document.getElementById('tool-header-icon');
    const name = document.getElementById('tool-header-name');
    if (icon) icon.textContent = def.icon;
    if (name) name.textContent = def.label;
    // 関係するパラメータ行のみ表示
    const params = new Set<string>(def.params);
    document.querySelectorAll<HTMLElement>('#tool-panel [data-param]').forEach(row => {
      row.style.display = params.has(row.dataset.param!) ? '' : 'none';
    });
    // テクスチャ操作はブラシのみ
    const tex = document.getElementById('texture-controls');
    if (tex) tex.style.display = tool === 'brush' ? '' : 'none';
    // パラメータを持たないツールには操作ヒントを表示
    const hint = document.getElementById('tool-hint');
    if (hint) {
      const text = TOOL_HINTS[tool];
      hint.textContent = text ?? '';
      hint.style.display = text ? '' : 'none';
    }
  }

  // ─────────────────────────────── フィルター ───────────────────────────────

  /** 各フィルターで表示するパラメータ行 */
  private static readonly FILTER_PARAMS: Record<FilterType, string[]> = {
    blur: ['radius'],
    glow: ['radius', 'threshold', 'intensity'],
    sharpen: ['radius', 'intensity'],
    exposure: ['ev'],
    levels: ['inLow', 'inHigh', 'gamma', 'outLow', 'outHigh'],
    curve: [],
  };

  /** 効果を追加（タブ状態に応じてセルまたはルートへ） */
  private addEffect(type: FilterType): void {
    if (!this.renderPipeline) return;
    let id: string;
    if (this.effectTab === 'root') {
      id = this.renderPipeline.addEffectToRoot(type);
    } else {
      const activeId = this.renderPipeline.getActiveLayerId();
      if (!activeId) return;
      id = this.renderPipeline.addEffectToCell(activeId, type);
    }
    this.editingEffectId = id;
    this.rebuildEffectChainPanel();
    this.refreshEffectEdit();
  }

  private currentFilterParams(): FilterParams {
    const num = (id: string) => parseFloat((document.getElementById(id) as HTMLInputElement).value);
    return {
      radius: num('filter-radius'),
      threshold: num('filter-threshold'),
      intensity: num('filter-intensity'),
      ev: num('filter-ev'),
      inLow: num('filter-inlow'),
      inHigh: num('filter-inhigh'),
      gamma: num('filter-gamma'),
      outLow: num('filter-outlow'),
      outHigh: num('filter-outhigh'),
    };
  }

  /** スライダー/ラベルを効果のパラメータで埋める */
  private setFilterControls(p: FilterParams): void {
    const set = (id: string, v: number, dp: number) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = String(v);
      const vl = document.getElementById(`${id}-val`);
      if (vl) vl.textContent = v.toFixed(dp);
    };
    set('filter-radius', p.radius, 0);
    set('filter-threshold', p.threshold, 1);
    set('filter-intensity', p.intensity, 1);
    set('filter-ev', p.ev, 1);
    set('filter-inlow', p.inLow, 2);
    set('filter-inhigh', p.inHigh, 2);
    set('filter-gamma', p.gamma, 2);
    set('filter-outlow', p.outLow, 2);
    set('filter-outhigh', p.outHigh, 2);
  }

  /** アクティブレイヤーが効果なら編集パネルを表示、そうでなければ隠す */
  private refreshEffectEdit(): void {
    const id = this.editingEffectId;
    const eff = id ? this.renderPipeline?.getEffect(id) : null;
    const params = document.getElementById('filter-params');
    if (!id || !eff) {
      this.editingEffectId = null;
      if (params) params.style.display = 'none';
      return;
    }
    const title = document.getElementById('effect-editor-title');
    const ownerLabel = eff.owner.kind === 'root' ? '撮影スタック' : `セル: ${eff.owner.cellId}`;
    if (title) title.textContent = `⚙ ${ownerLabel} の効果設定`;
    const visible = new Set(PhotonMixerApp.FILTER_PARAMS[eff.filterType]);
    document.querySelectorAll<HTMLElement>('#filter-params [data-fparam]').forEach(row => {
      row.style.display = visible.has(row.dataset.fparam!) ? '' : 'none';
    });
    this.setFilterControls(eff.params);
    // 入力ソース選択は新モデルでは不要（効果はセルまたはルートに付属）
    const sourceSel = document.getElementById('filter-source');
    if (sourceSel) sourceSel.style.display = 'none';
    const curveEd = document.getElementById('filter-curve-editor');
    if (curveEd) curveEd.style.display = eff.filterType === 'curve' ? '' : 'none';
    if (eff.filterType === 'curve' && this.curveEditor) this.curveEditor.setPoints(eff.curvePoints ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    if (params) params.style.display = '';
  }

  /** 効果パラメータのスライダー変更を反映 */
  private onEffectParamInput(): void {
    if (this.editingEffectId) this.renderPipeline?.setEffectParams(this.editingEffectId, this.currentFilterParams());
  }

  /** Freeze（焼き込み）: 効果をピクセルに確定する */
  private freezeEffect(): void {
    if (!this.editingEffectId || !this.renderPipeline) return;
    const eff = this.renderPipeline.getEffect(this.editingEffectId);
    if (!eff) return;
    if (eff.owner.kind === 'root') {
      this.renderPipeline.freezeRootEffects();
    } else {
      this.renderPipeline.freezeCellEffects(eff.owner.cellId);
    }
    // レイヤー構造が変わるため履歴はクリア（焼き込みは Undo 非対応）
    this.layerHistories.clear();
    this.editingEffectId = null;
    this.rebuildLayerPanel();
    this.refreshEffectEdit();
  }

  /** 現在の表示（View）設定を UI から取得（.pmx 保存用） */
  private currentViewSettings(): { viewEV: number; tonemap: TonemapId; viewMode: DisplayModeId } {
    return {
      viewEV: parseFloat((document.getElementById('view-exposure') as HTMLInputElement).value),
      tonemap: (document.getElementById('view-tonemap') as HTMLSelectElement).value as TonemapId,
      viewMode: (document.getElementById('view-mode') as HTMLSelectElement).value as DisplayModeId,
    };
  }

  /** View 設定を UI とエンジンへ適用（.pmx 読込時） */
  private applyViewSettings(v: { viewEV: number; tonemap: TonemapId; viewMode: DisplayModeId }): void {
    const exp = document.getElementById('view-exposure') as HTMLInputElement | null;
    const expVal = document.getElementById('view-exposure-val');
    const tone = document.getElementById('view-tonemap') as HTMLSelectElement | null;
    const mode = document.getElementById('view-mode') as HTMLSelectElement | null;
    if (exp) exp.value = String(v.viewEV);
    if (expVal) expVal.textContent = (v.viewEV >= 0 ? '+' : '') + v.viewEV.toFixed(1);
    if (tone) tone.value = v.tonemap;
    if (mode) mode.value = v.viewMode;
    this.renderPipeline?.setDisplayParams(evToExposure(v.viewEV), v.tonemap, v.viewMode);
  }

  private async handleSpoit(x: number, y: number): Promise<void> {
    if (!this.renderPipeline) return;
    // 仕様: 全レイヤー合成結果の内部リニア値を拾う（表示変換後の色ではない）
    const snap = await this.renderPipeline.requestCompositeSnapshot();
    const { width, height } = this.viewport.getCanvasSize();
    const c = sampleSnapshot(snap.data, x, y, width, height, snap.bytesPerRow);
    // committed はプリマルチプライドαなので straight color に戻す（α=0 は透明＝拾わない）
    if (c.a < 0.001) { this.updateSpoitGap(null); return; }
    const straight: LinearColor = { r: c.r / c.a, g: c.g / c.a, b: c.b / c.a, a: 1 };
    this.updateCurrentColor(straight);
    this.updateSpoitGap(straight);
  }

  /**
   * スポイト知覚ギャップ表示: 内部リニア値と表示上の見え方の乖離が大きいときのみ
   * 「内部値 / 表示」の色チップを並べて表示する（仕様）。
   */
  private updateSpoitGap(c: LinearColor | null): void {
    const el = document.getElementById('spoit-gap');
    if (!el) return;
    if (!c) { el.style.display = 'none'; return; }
    const view = this.currentViewSettings();
    const hdr = Math.max(c.r, c.g, c.b) > 1.0;
    const gap = hdr || view.viewEV !== 0 || view.tonemap !== 'none';
    if (!gap) { el.style.display = 'none'; return; }

    const toHex = (rgb: { r: number; g: number; b: number }) =>
      '#' + [rgb.r, rgb.g, rgb.b].map(v => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('');
    const rawHex = toHex(linearColorToSrgb(c)); // 内部値（クランプ表示）
    const disp = linearToDisplaySrgb([c.r, c.g, c.b], evToExposure(view.viewEV), view.tonemap);
    const dispHex = toHex({ r: disp[0], g: disp[1], b: disp[2] });
    const f = (v: number) => v.toFixed(v >= 10 ? 1 : 3);
    el.innerHTML =
      `<div style="font-size:9px; color:#7fb2ff; margin-bottom:3px;">スポイト（内部値 / 表示）${hdr ? ' <span style="color:#000;background:#ffb24a;border-radius:6px;padding:0 4px;">HDR</span>' : ''}</div>` +
      `<div style="display:flex; gap:8px; align-items:center; font-size:9px; color:#9a9;">` +
      `<div style="text-align:center;"><div style="width:28px;height:20px;background:${rawHex};border:1px solid #555;"></div>内部値</div>` +
      `<div style="text-align:center;"><div style="width:28px;height:20px;background:${dispHex};border:1px solid #555;"></div>表示</div>` +
      `<div>R:${f(c.r)}<br>G:${f(c.g)}<br>B:${f(c.b)}</div>` +
      `</div>`;
    el.style.display = '';
  }

  private updateCurrentColor(color: LinearColor): void {
    this.state.currentColor = { ...color };
    const srgb = linearColorToSrgb(color);
    const hex = '#' + [srgb.r, srgb.g, srgb.b].map(v =>
      Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
    ).join('');

    const colorPicker = document.getElementById('brush-color') as HTMLInputElement;
    if (colorPicker) colorPicker.value = hex;
    // HSV ピッカーも同期（HDR対応＝色度とEVに分解。スポイト/プリセット適用時）
    this.colorPicker?.setLinear(color);
    this.renderPipeline?.updateBrushConfig({ color });
  }

  private async handleBucketFill(x: number, y: number): Promise<void> {
    if (!this.renderPipeline) return;

    const { width, height } = this.viewport.getCanvasSize();
    const snap = await this.renderPipeline.requestCommittedSnapshot();
    const data = snap.data;
    const uint16sPerRow = snap.bytesPerRow / 2;

    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || ix >= width || iy < 0 || iy >= height) return;

    // 選択範囲マスク（null=選択なし=全域対象）
    const sel = this.renderPipeline.getSelectionMaskData();
    const mask = sel?.data ?? null;
    // 開始点が選択範囲外なら何もしない
    if (mask && mask[iy * width + ix] === 0) return;

    const inSelection = (px: number, py: number): boolean =>
      !mask || mask[py * width + px] !== 0;

    const targetColor = this.state.currentColor;

    // committed はプリマルチプライドαなので RGB を α 倍して書き込む
    const ta = targetColor.a;
    const target16 = new Uint16Array([
      float32ToFloat16(targetColor.r * ta),
      float32ToFloat16(targetColor.g * ta),
      float32ToFloat16(targetColor.b * ta),
      float32ToFloat16(ta),
    ]);

    // 開始点の straight color（許容値比較の基準）
    const startStraight = this.pixelStraight(data, ix, iy, uint16sPerRow);
    const tol = this.state.bucketTolerance;

    // シンプルなシードフィル (スキャンライン)
    const stack: [number, number][] = [[ix, iy]];
    const processed = new Uint8Array(width * height);

    while (stack.length > 0) {
      const [cx, cy] = stack.pop()!;
      let lx = cx;
      while (lx > 0 && inSelection(lx - 1, cy) && this.isSameColor(data, lx - 1, cy, startStraight, tol, uint16sPerRow)) {
        lx--;
      }
      let rx = cx;
      while (rx < width - 1 && inSelection(rx + 1, cy) && this.isSameColor(data, rx + 1, cy, startStraight, tol, uint16sPerRow)) {
        rx++;
      }

      for (let i = lx; i <= rx; i++) {
        const idx = cy * uint16sPerRow + i * 4;
        data[idx] = target16[0];
        data[idx + 1] = target16[1];
        data[idx + 2] = target16[2];
        data[idx + 3] = target16[3];
        processed[cy * width + i] = 1;

        if (cy > 0 && !processed[(cy - 1) * width + i] && inSelection(i, cy - 1) && this.isSameColor(data, i, cy - 1, startStraight, tol, uint16sPerRow)) {
          stack.push([i, cy - 1]);
        }
        if (cy < height - 1 && !processed[(cy + 1) * width + i] && inSelection(i, cy + 1) && this.isSameColor(data, i, cy + 1, startStraight, tol, uint16sPerRow)) {
          stack.push([i, cy + 1]);
        }
      }
    }

    this.renderPipeline.updateCommittedTexture(data);
    // 塗りつぶし直後のスナップショットを履歴に積む（rebake で上書き再現＝Undo 可能）
    this.addHistoryRecord({ kind: 'fill', snapshot: data, bytesPerRow: snap.bytesPerRow });
  }

  /** ピクセルを straight color（アンプリマルチプライド）で取得 */
  private pixelStraight(data: Uint16Array, x: number, y: number, uint16sPerRow: number): LinearColor {
    const idx = y * uint16sPerRow + x * 4;
    const a = float16ToFloat32(data[idx + 3]);
    const inv = a > 0.0001 ? 1 / a : 0;
    return {
      r: float16ToFloat32(data[idx]) * inv,
      g: float16ToFloat32(data[idx + 1]) * inv,
      b: float16ToFloat32(data[idx + 2]) * inv,
      a,
    };
  }

  /**
   * 許容値つき同色判定。straight color の各チャンネル差と α 差が tol 以内なら同色
   */
  private isSameColor(data: Uint16Array, x: number, y: number, ref: LinearColor, tol: number, uint16sPerRow: number): boolean {
    const c = this.pixelStraight(data, x, y, uint16sPerRow);
    return Math.abs(c.r - ref.r) <= tol
      && Math.abs(c.g - ref.g) <= tol
      && Math.abs(c.b - ref.b) <= tol
      && Math.abs(c.a - ref.a) <= tol;
  }

  /** 確定 prefix と可変末尾を、引きずり混色の状態を保ったまま処理する。 */
  private handleProgressiveUpdate(update: LiveStrokeUpdate): void {
    if (!this.progressiveStrokeState) return;

    if (update.flushed.length > 0) {
      const flushed = this.strokeManager.finalizeStroke(update.flushed);
      this.colorizeProgressivePoints(flushed, this.progressiveStrokeState);
      this.liveStrokePoints.push(...flushed);
      this.appendIncrementalGpuChunks(flushed);
    }

    const tail = this.strokeManager.finalizeStroke(update.tail);
    const previewState = this.cloneProgressiveState(this.progressiveStrokeState);
    this.colorizeProgressivePoints(tail, previewState);
    this.renderPipeline?.setCurrentStroke(tail);
    this.perfMonitor.setPoints(this.liveStrokePoints.length + tail.length);
  }

  /**
   * smudge と deposit を分離した色計算を、渡された継続状態から増分適用する。
   * preview では状態の複製、prefix 確定時は本体を渡す。
   */
  private colorizeProgressivePoints(stroke: StrokePoint[], state: ProgressiveStrokeState): void {
    if (stroke.length === 0) return;

    const orig = state.baseColor;
    // ぼかし筆: ブラシ色を注入せず既存色だけを引き伸ばす（deposit=smudge）
    const blur = this.state.currentTool === 'blur';
    const wet = blur ? 1.0 : this.state.wetRatio;
    const snap = this.committedSnapshot;
    const { width: canvasW, height: canvasH } = this.viewport.getCanvasSize();

    // smudge が既存色/ブラシ色へドリフトする e-fold 距離（px）。小さいほど速く拾う
    const SMUDGE_LEN = 25;
    const origOklab = linearToOklab(orig);

    for (const p of stroke) {
      if (state.prevX === null || state.prevY === null) {
        state.prevX = p.x;
        state.prevY = p.y;
      }
      const dx = p.x - state.prevX, dy = p.y - state.prevY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      state.prevX = p.x; state.prevY = p.y;
      const rate = 1 - Math.exp(-dist / SMUDGE_LEN);

      // ① smudge をドリフト
      // ブラシ混色は空白でブラシ色へ戻すが、ぼかしは空白では現状の smudge を保持
      let targetOklab = blur ? linearToOklab(state.smudge) : origOklab;
      let driftT = rate;
      if (snap) {
        const cc = sampleSnapshot(snap.data, p.x, p.y, canvasW, canvasH, snap.bytesPerRow);
        if (cc.a > 0.001) {
          // 既存色を拾う（薄い既存色は弱く拾う）
          targetOklab = linearToOklab({ r: cc.r / cc.a, g: cc.g / cc.a, b: cc.b / cc.a, a: 1 });
          driftT = rate * cc.a;
        }
      }
      if (driftT > 0) {
        const s = oklabToLinear(mixOklab(linearToOklab(state.smudge), targetOklab, driftT));
        state.smudge = { r: s.r, g: s.g, b: s.b, a: orig.a };
      }

      // ② deposit = ブラシ色と smudge を wet で補間（ぼかしは wet=1 → smudge そのもの）
      const dep = oklabToLinear(mixOklab(origOklab, linearToOklab(state.smudge), wet));
      // 筆圧によるα変化はシェーダーで一度だけ適用する。
      p.color = { r: dep.r, g: dep.g, b: dep.b, a: orig.a };
    }
  }

  private cloneProgressiveState(state: ProgressiveStrokeState): ProgressiveStrokeState {
    return {
      baseColor: { ...state.baseColor },
      smudge: { ...state.smudge },
      prevX: state.prevX,
      prevY: state.prevY,
    };
  }

  /**
   * 始点→現在点の直線をストロークとして生成（Shift で角度スナップ）
   */
  private buildLineStroke(ex: number, ey: number): StrokePoint[] {
    if (!this.lineStart) return [];
    let { x: sx, y: sy } = this.lineStart;
    let dx = ex - sx, dy = ey - sy;

    // Shift: 0/45/90度にスナップ
    if (this.shiftDown) {
      const len = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      dx = Math.cos(snapped) * len;
      dy = Math.sin(snapped) * len;
    }

    const len = Math.hypot(dx, dy);
    const steps = Math.max(2, Math.ceil(len)); // 1px 間隔
    const pressure = 0.7; // 直線は一定筆圧
    const raw: import('./pen/input.js').PointerPoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      raw.push({ x: sx + dx * t, y: sy + dy * t, pressure, tiltX: 0, tiltY: 0, timestamp: 0 });
    }
    return this.strokeManager.finalizeStroke(raw);
  }

  /** スタンプモードの確定 prefix をフラッシュし、短い末尾だけをライブ表示する。 */
  private handleStampUpdate(update: LiveStrokeUpdate): void {
    if (update.flushed.length > 0) {
      const flushed = this.strokeManager.finalizeStroke(update.flushed);
      this.bakeColorIntoPoints(flushed);
      this.liveStrokePoints.push(...flushed);
      this.appendIncrementalGpuChunks(flushed);
    }

    const tail = this.strokeManager.finalizeStroke(update.tail);
    this.renderPipeline?.setCurrentStroke(tail);
    this.perfMonitor.setPoints(this.liveStrokePoints.length + tail.length);
  }

  /** GPUの固定点数バッファを越えない局所チャンクとして一筆 accumulator へ追加する。 */
  private appendIncrementalGpuChunks(points: StrokePoint[]): void {
    const CHUNK_POINTS = 4096;
    for (let i = 0; i < points.length; i += CHUNK_POINTS) {
      this.renderPipeline?.appendIncrementalStroke(points.slice(i, i + CHUNK_POINTS));
    }
  }

  /**
   * 各点に現在のブラシ色を焼き込む（Undo/Redo の rebake で色を忠実に再現するため）
   * 筆圧によるα変化はシェーダー側で適用し、履歴には元のαを保持する。
   */
  private bakeColorIntoPoints(points: StrokePoint[]): void {
    const c = this.state.currentColor;
    for (const p of points) {
      if (!p.color) {
        p.color = { r: c.r, g: c.g, b: c.b, a: c.a };
      }
    }
  }

  private setupControls(): void {
    // UI→エンジン反映の窓口を生成（strokeManager/stabilizer は構築済み、pipeline は遅延参照）
    this.engineCtx = createEngineCtx({
      strokeManager: this.strokeManager,
      stabilizer: this.stabilizer,
      postCorrector: this.postCorrector,
      getPipeline: () => this.renderPipeline,
      state: this.state,
    });
    // ツール個別状態（定義の既定値で初期化）
    this.toolSettings = new ToolSettingsStore(TOOLS, PARAM_DEFS);
    // 初期ツールのヘッダー・表示パラメータを反映
    this.refreshToolOptions(this.state.currentTool);

    // 左の縦ツールバー（定義から自動生成）。クリックは onSelect 経由で setTool へ。
    this.toolBar = document.getElementById('tool-bar') as ToolBar | null;
    if (this.toolBar) {
      this.toolBar.onSelect = (id) => this.setTool(id);
      this.toolBar.setActive(this.state.currentTool);
    }
    document.getElementById('select-all')?.addEventListener('click', () => this.selectAll());
    document.getElementById('select-clear')?.addEventListener('click', () => this.clearSelectionUI());
    document.getElementById('select-mode-rect')?.addEventListener('click', () => this.setSelectMode('rect'));
    document.getElementById('select-mode-lasso')?.addEventListener('click', () => this.setSelectMode('lasso'));
    document.getElementById('select-mode-wand')?.addEventListener('click', () => this.setSelectMode('wand'));
    document.getElementById('select-invert')?.addEventListener('click', () => this.invertSelectionUI());
    document.getElementById('transform-commit')?.addEventListener('click', () => this.commitTransformUI());
    document.getElementById('transform-cancel')?.addEventListener('click', () => this.cancelTransformUI());

    const sizeSlider    = document.getElementById('brush-size')    as HTMLInputElement;
    const sizeNum       = document.getElementById('brush-size-num') as HTMLInputElement;
    const alphaSlider   = document.getElementById('brush-alpha')   as HTMLInputElement;
    const alphaVal      = document.getElementById('brush-alpha-val')!;
    const wetSlider     = document.getElementById('brush-wet')     as HTMLInputElement;
    const wetVal        = document.getElementById('brush-wet-val')!;
    const colorPicker   = document.getElementById('brush-color')   as HTMLInputElement;
    const mixModeSelect = document.getElementById('mix-mode')      as HTMLSelectElement;
    const clearBtn      = document.getElementById('clear-btn')!;

    // ブラシサイズ同期ヘルパー（DOM同期＋エンジン反映）
    const updateBrushSize = (size: number) => {
      const clamped = Math.max(1, Math.min(100, size));
      sizeSlider.value = clamped.toString();
      sizeNum.value = clamped.toString();
      this.engineCtx.setSize(clamped);
    };

    sizeSlider.addEventListener('input', () => {
      updateBrushSize(parseInt(sizeSlider.value));
    });

    sizeNum.addEventListener('input', () => {
      updateBrushSize(parseInt(sizeNum.value) || 1);
    });

    sizeNum.addEventListener('change', () => {
      // Enter やフォーカス失った時に範囲クランプ
      const val = parseInt(sizeNum.value) || 1;
      updateBrushSize(Math.max(1, Math.min(100, val)));
    });

    alphaSlider.addEventListener('input', () => {
      alphaVal.textContent = alphaSlider.value;
      this.engineCtx.setOpacity(parseInt(alphaSlider.value) / 100);
    });

    // 筆圧で不透明度反映 ON/OFF
    const pressureOpacityCheckbox = document.getElementById('brush-pressure-opacity') as HTMLInputElement;
    pressureOpacityCheckbox?.addEventListener('change', () => {
      const enabled = pressureOpacityCheckbox.checked;
      this.toolSettings.set(this.state.currentTool, 'pressureOpacity', enabled);
      this.engineCtx.setPressureOpacity(enabled);
    });

    wetSlider.addEventListener('input', () => {
      wetVal.textContent = wetSlider.value;
      this.engineCtx.setWet(parseInt(wetSlider.value) / 100);
    });

    // HSV カラーピッカー（input type=color は隠し互換用として残す）
    const pickerContainer = document.getElementById('color-picker')!;
    this.colorPicker = new ColorPicker(pickerContainer, (linear) => {
      // linear は HDR 可（EV込み）。RGB だけ更新し α（不透明度）は維持する
      this.state.currentColor.r = linear.r;
      this.state.currentColor.g = linear.g;
      this.state.currentColor.b = linear.b;
      const srgb = linearColorToSrgb(linear); // 互換用の隠し input（クランプ済み）
      const hex = '#' + [srgb.r, srgb.g, srgb.b].map(v => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('');
      colorPicker.value = hex;
      this.renderPipeline?.updateBrushConfig({ color: { ...this.state.currentColor } });
    });

    mixModeSelect.addEventListener('change', () => {
      this.engineCtx.setMixMode(mixModeSelect.value as BrushMixMode);
    });

    const exportPngBtn = document.getElementById('export-png-btn');
    exportPngBtn?.addEventListener('click', async () => {
      if (!this.renderPipeline) return;
      try {
        const blob = await this.renderPipeline.exportToPNG();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `photonmixer_${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        console.error('PNG export failed:', e);
        alert('PNG 書き出しに失敗しました。');
      }
    });

    clearBtn.addEventListener('click', () => {
      this.renderPipeline?.clear();
      this.activeHistory().clear();
    });

    // レイヤー操作
    document.getElementById('layer-add')?.addEventListener('click', () => {
      this.renderPipeline?.addLayer();
      this.rebuildLayerPanel();
      this.refreshEffectEdit();
    });
    document.getElementById('layer-add-folder')?.addEventListener('click', () => {
      this.renderPipeline?.addFolder();
      this.rebuildLayerPanel();
    });
    document.getElementById('layer-del')?.addEventListener('click', () => {
      const id = this.renderPipeline?.getActiveLayerId();
      this.renderPipeline?.removeActiveLayer();
      if (id) this.layerHistories.delete(id);
      this.rebuildLayerPanel();
      this.refreshEffectEdit();
    });
    document.getElementById('layer-up')?.addEventListener('click', () => {
      this.renderPipeline?.moveActiveLayer('up');
      this.rebuildLayerPanel();
    });
    document.getElementById('layer-down')?.addEventListener('click', () => {
      this.renderPipeline?.moveActiveLayer('down');
      this.rebuildLayerPanel();
    });

    // 効果チェーン パネル タブ（セル / 撮影スタック）
    document.getElementById('effect-tab-cell')?.addEventListener('click', () => {
      this.effectTab = 'cell';
      document.getElementById('effect-tab-cell')?.classList.add('active');
      document.getElementById('effect-tab-root')?.classList.remove('active');
      this.rebuildEffectChainPanel();
    });
    document.getElementById('effect-tab-root')?.addEventListener('click', () => {
      this.effectTab = 'root';
      document.getElementById('effect-tab-root')?.classList.add('active');
      document.getElementById('effect-tab-cell')?.classList.remove('active');
      this.editingEffectId = null;
      this.rebuildEffectChainPanel();
      this.refreshEffectEdit();
    });

    // 手ブレ補正の強度（0%=補正なし, 100%=最も滑らか）
    const stabSlider = document.getElementById('brush-stabilize') as HTMLInputElement;
    const stabVal = document.getElementById('brush-stabilize-val')!;
    const applyStabilize = (pct: number) => {
      stabVal.textContent = pct.toString();
      this.engineCtx.setStabilize(pct);
    };
    stabSlider?.addEventListener('input', () => applyStabilize(parseInt(stabSlider.value)));
    applyStabilize(parseInt(stabSlider.value)); // 初期値を反映

    // 手ブレ補正方式（EMA / Pulled String）
    const stabModeSel = document.getElementById('brush-stabilize-mode') as HTMLSelectElement;
    stabModeSel?.addEventListener('change', () => {
      this.engineCtx.setStabilizeMode(stabModeSel.value as 'ema' | 'pulled-string');
    });

    // 後補正（事後補正）のオン/オフ + 強度
    const postCorrectCheck = document.getElementById('brush-post-correct') as HTMLInputElement;
    const postCorrectSlider = document.getElementById('brush-post-correct-strength') as HTMLInputElement;
    const postCorrectVal = document.getElementById('brush-post-correct-val')!;
    const applyPostCorrect = () => {
      const enabled = postCorrectCheck.checked;
      const pct = parseInt(postCorrectSlider.value);
      postCorrectVal.textContent = pct.toString();
      postCorrectSlider.disabled = !enabled;
      this.engineCtx.setPostCorrection(enabled);
      this.engineCtx.setPostCorrectionStrength(pct);
    };
    postCorrectCheck?.addEventListener('change', applyPostCorrect);
    postCorrectSlider?.addEventListener('input', applyPostCorrect);
    applyPostCorrect();

    // 筆圧カーブ
    const curveSel = document.getElementById('pressure-curve') as HTMLSelectElement;
    curveSel?.addEventListener('change', () => {
      this.engineCtx.setPressureCurve(curveSel.value as any);
    });

    // 効果（非破壊エフェクト）を追加するボタン
    document.getElementById('filter-blur')?.addEventListener('click', () => this.addEffect('blur'));
    document.getElementById('filter-glow')?.addEventListener('click', () => this.addEffect('glow'));
    document.getElementById('filter-sharpen')?.addEventListener('click', () => this.addEffect('sharpen'));
    document.getElementById('filter-exposure')?.addEventListener('click', () => this.addEffect('exposure'));
    document.getElementById('filter-levels')?.addEventListener('click', () => this.addEffect('levels'));
    document.getElementById('filter-curve')?.addEventListener('click', () => this.addEffect('curve'));
    // Freeze（焼き込み）
    document.getElementById('freeze-effect')?.addEventListener('click', () => this.freezeEffect());
    // 入力ソース選択は新モデルでは廃止（効果はセルまたはルートに付属）
    // トーンカーブエディタ（変更で編集中の効果へ反映）
    const curveContainer = document.getElementById('filter-curve-editor');
    if (curveContainer) {
      this.curveEditor = new CurveEditor(curveContainer, () => {
        if (this.editingEffectId && this.curveEditor) {
          this.renderPipeline?.setEffectCurve(this.editingEffectId, this.curveEditor.getPoints());
        }
      });
    }
    // id → 値ラベルの小数桁
    const filterDecimals: Record<string, number> = {
      'filter-radius': 0, 'filter-ev': 1, 'filter-threshold': 1, 'filter-intensity': 1,
      'filter-inlow': 2, 'filter-inhigh': 2, 'filter-gamma': 2, 'filter-outlow': 2, 'filter-outhigh': 2,
    };
    for (const [id, dp] of Object.entries(filterDecimals)) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      el?.addEventListener('input', () => {
        const valEl = document.getElementById(`${id}-val`);
        if (valEl) valEl.textContent = parseFloat(el.value).toFixed(dp);
        this.onEffectParamInput();
      });
    }

    // 表示（光）コントロール：露出 / トーンマップ / 表示モード
    const viewExp = document.getElementById('view-exposure') as HTMLInputElement;
    const viewExpVal = document.getElementById('view-exposure-val')!;
    const viewTone = document.getElementById('view-tonemap') as HTMLSelectElement;
    const viewMode = document.getElementById('view-mode') as HTMLSelectElement;
    const applyDisplay = () => {
      const ev = parseFloat(viewExp.value);
      viewExpVal.textContent = (ev >= 0 ? '+' : '') + ev.toFixed(1);
      this.renderPipeline?.setDisplayParams(evToExposure(ev), viewTone.value as TonemapId, viewMode.value as DisplayModeId);
    };
    viewExp?.addEventListener('input', applyDisplay);
    viewTone?.addEventListener('change', applyDisplay);
    viewMode?.addEventListener('change', applyDisplay);
    applyDisplay(); // 初期値を反映

    // 塗りつぶし許容値
    const tolSlider = document.getElementById('bucket-tolerance') as HTMLInputElement;
    const tolVal = document.getElementById('bucket-tolerance-val')!;
    tolSlider?.addEventListener('input', () => {
      tolVal.textContent = tolSlider.value;
      this.engineCtx.setTolerance(parseInt(tolSlider.value) / 100);
    });

    // 背景色
    const bgTransparent = document.getElementById('bg-transparent');
    const bgWhite = document.getElementById('bg-white');
    const bgColor = document.getElementById('bg-color') as HTMLInputElement;
    const setBgActive = (which: 'transparent' | 'white' | 'custom') => {
      bgTransparent?.classList.toggle('active', which === 'transparent');
      bgWhite?.classList.toggle('active', which === 'white');
    };
    bgTransparent?.addEventListener('click', () => {
      this.renderPipeline?.setBackgroundColor(null);
      setBgActive('transparent');
    });
    bgWhite?.addEventListener('click', () => {
      this.renderPipeline?.setBackgroundColor({ r: 1, g: 1, b: 1 });
      setBgActive('white');
    });
    bgColor?.addEventListener('input', () => {
      const hex = bgColor.value;
      this.renderPipeline?.setBackgroundColor({
        r: srgbToLinear(parseInt(hex.substring(1, 3), 16) / 255),
        g: srgbToLinear(parseInt(hex.substring(3, 5), 16) / 255),
        b: srgbToLinear(parseInt(hex.substring(5, 7), 16) / 255),
      });
      setBgActive('custom');
    });

    // .pmx 保存 / 開く
    document.getElementById('save-pmx-btn')?.addEventListener('click', () => this.savePmxFile());
    document.getElementById('open-pmx-btn')?.addEventListener('click', () => {
      (document.getElementById('pmx-file-input') as HTMLInputElement).click();
    });
    (document.getElementById('pmx-file-input') as HTMLInputElement)?.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) await this.openPmxFile(file);
      (e.target as HTMLInputElement).value = '';
    });

    // テクスチャブラシ関連
    const loadTextureBtn = document.getElementById('load-texture-btn');
    const clearTextureBtn = document.getElementById('clear-texture-btn');
    const textureScaleSlider = document.getElementById('texture-scale') as HTMLInputElement;
    const textureScaleVal = document.getElementById('texture-scale-val')!;
    const textureFileInput = document.getElementById('texture-file-input') as HTMLInputElement;

    // テクスチャ読み込み
    loadTextureBtn?.addEventListener('click', () => {
      textureFileInput.click();
    });

    textureFileInput.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file || !this.renderPipeline) return;

      try {
        const image = await createImageBitmap(file);
        await this.renderPipeline.loadBrushTexture(image);
        this.currentTextureBitmap = image;
        this.state.useTexture = true;
        this.renderPipeline.updateBrushConfig({ useTexture: true });
      } catch (err) {
        console.error('Failed to load texture:', err);
        alert('テクスチャの読み込みに失敗しました。');
      }
      // 入力をリセット
      textureFileInput.value = '';
    });

    // テクスチャクリア
    clearTextureBtn?.addEventListener('click', () => {
      this.renderPipeline?.clearBrushTexture();
      this.currentTextureBitmap = null;
      this.state.useTexture = false;
      this.renderPipeline?.updateBrushConfig({ useTexture: false });
    });

    // テクスチャスケール
    textureScaleSlider.addEventListener('input', () => {
      const scale = parseFloat(textureScaleSlider.value);
      textureScaleVal.textContent = scale.toString();
      this.engineCtx.setTextureScale(scale);
    });

    // プリセット関連
    const savePresetBtn = document.getElementById('save-preset-btn');
    const loadPresetBtn = document.getElementById('load-preset-btn');
    const presetFileInput = document.getElementById('preset-file-input') as HTMLInputElement;

    // プリセット保存
    savePresetBtn?.addEventListener('click', async () => {
      if (!this.renderPipeline) return;

      try {
        // 現在のブラシ設定を取得
        const config = this.getCurrentBrushConfig();

        // プリセット名を生成（またはプロンプト）
        const name = BrushPresetManager.generatePresetName();

        // テクスチャブラシなら元画像も同梱する
        const textureBitmap = config.useTexture ? (this.currentTextureBitmap ?? undefined) : undefined;

        const preset = { name, version: '1.0', config };

        // ZIPとして保存
        const blob = await BrushPresetManager.savePreset(preset, textureBitmap);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}.zip`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        console.error('Failed to save preset:', e);
        alert('プリセットの保存に失敗しました。');
      }
    });

    // プリセット読み込み
    loadPresetBtn?.addEventListener('click', () => {
      presetFileInput.click();
    });

    presetFileInput.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file || !this.renderPipeline) return;

      try {
        const preset = await BrushPresetManager.loadPreset(file);

        // ブラシ設定を適用
        this.applyBrushConfig(preset.config);

        // テクスチャの同期（プリセットにテクスチャがあればロード、なければクリア）
        if (preset.textureBitmap) {
          await this.renderPipeline.loadBrushTexture(preset.textureBitmap);
          this.currentTextureBitmap = preset.textureBitmap;
          this.state.useTexture = preset.config.useTexture;
        } else {
          this.renderPipeline.clearBrushTexture();
          this.currentTextureBitmap = null;
          this.state.useTexture = false;
          this.renderPipeline.updateBrushConfig({ useTexture: false });
        }

        alert(`プリセット「${preset.name}」を読み込みました。`);
      } catch (e) {
        console.error('Failed to load preset:', e);
        alert('プリセットの読み込みに失敗しました。');
      }
      // 入力をリセット
      presetFileInput.value = '';
    });
  }

  /**
   * 現在のブラシ設定を取得
   */
  private getCurrentBrushConfig(): BrushConfig {
    return {
      color: { ...this.state.currentColor },
      wetRatio: this.state.wetRatio,
      mixMode: this.state.mixMode,
      usePointColor: false,
      useTexture: this.state.useTexture,
      textureScale: this.state.textureScale,
      alphaLock: false,
      pressureOpacity: this.state.pressureOpacity,
    };
  }

  /**
   * ブラシ設定を適用
   */
  private applyBrushConfig(config: BrushConfig): void {
    // 旧プリセットには pressureOpacity が無い場合があるため、ここで既定値を補う
    const normalizedConfig: BrushConfig = {
      ...config,
      pressureOpacity: Boolean(config.pressureOpacity),
    };

    // 色を適用
    this.updateCurrentColor(normalizedConfig.color);

    // 不透明度スライダーを更新
    const alphaSlider = document.getElementById('brush-alpha') as HTMLInputElement;
    const alphaVal = document.getElementById('brush-alpha-val')!;
    const alpha = Math.round(normalizedConfig.color.a * 100);
    alphaSlider.value = alpha.toString();
    alphaVal.textContent = alpha.toString();

    // 筆圧濃度チェックボックスを更新
    const pressureOpacityCheckbox = document.getElementById('brush-pressure-opacity') as HTMLInputElement;
    if (pressureOpacityCheckbox) {
      pressureOpacityCheckbox.checked = normalizedConfig.pressureOpacity;
      this.state.pressureOpacity = normalizedConfig.pressureOpacity;
    }

    // にじみスライダーを更新
    const wetSlider = document.getElementById('brush-wet') as HTMLInputElement;
    const wetVal = document.getElementById('brush-wet-val')!;
    const wet = Math.round(normalizedConfig.wetRatio * 100);
    wetSlider.value = wet.toString();
    wetVal.textContent = wet.toString();
    this.state.wetRatio = normalizedConfig.wetRatio;

    // 方式セレクトを更新
    const mixModeSelect = document.getElementById('mix-mode') as HTMLSelectElement;
    mixModeSelect.value = normalizedConfig.mixMode;
    this.state.mixMode = normalizedConfig.mixMode;

    // テクスチャスケールを更新
    const textureScaleSlider = document.getElementById('texture-scale') as HTMLInputElement;
    const textureScaleVal = document.getElementById('texture-scale-val')!;
    textureScaleSlider.value = normalizedConfig.textureScale.toString();
    textureScaleVal.textContent = normalizedConfig.textureScale.toString();
    this.state.textureScale = normalizedConfig.textureScale;

    // RenderPipeline に適用
    this.renderPipeline?.updateBrushConfig(normalizedConfig);
  }

  private handleResize(): void {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    if (!canvas || !this.renderPipeline) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    this.renderPipeline.resizeScreenSize(window.innerWidth, window.innerHeight);
    // 選択オーバーレイもウィンドウサイズに合わせる
    const overlay = document.getElementById('selection-overlay') as HTMLCanvasElement | null;
    if (overlay) { overlay.width = window.innerWidth; overlay.height = window.innerHeight; }
    // リサイズ後もビューポートを更新
    const transform = this.viewport.getTransform();
    this.renderPipeline.updateViewport(transform.scale, transform.offsetX, transform.offsetY, transform.rotation, transform.flip);
    this.drawSelectionOverlay();
  }

  private startRenderLoop(): void {
    let lastCleanup = 0;

    const frame = (timestamp: number) => {
      this.perfMonitor.beginFrame(timestamp);
      this.renderPipeline?.render();
      this.perfMonitor.endFrame(timestamp);

      if (timestamp - lastCleanup > 1000) {
        this.perfMonitor.cleanup();
        lastCleanup = timestamp;
      }

      requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new PhotonMixerApp();
  app.init().catch((e) => {
    console.error('Failed to initialize app:', e);
  });
});
