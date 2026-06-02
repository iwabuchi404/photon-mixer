/**
 * PhotonMixer メインエントリーポイント
 */

import { initRenderer } from './core/renderer.js';
import { PenInputManager } from './pen/input.js';
import { Stabilizer } from './pen/stabilization.js';
import { Interpolator } from './pen/interpolation.js';
import { StrokeManager, StrokeHistory } from './pen/stroke.js';
import { RenderPipeline } from './render/pipeline.js';
import { PerfMonitor } from './ui/perf-monitor.js';
import { Viewport } from './viewport.js';
import { srgbToLinear, linearColorToSrgb } from './color/linear.js';
import { linearToOklab, oklabToLinear, mixOklab } from './color/oklab.js';
import { BrushPresetManager } from './brush-preset.js';
import { savePmx, loadPmx } from './pmx.js';
import type { LinearColor } from './color/types.js';
import type { StrokePoint } from './pen/stroke.js';
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

type Tool = 'brush' | 'eraser' | 'spoit' | 'bucket';

interface AppState {
  isDrawing: boolean;
  currentColor: LinearColor;
  wetRatio: number;
  mixMode: BrushMixMode;
  currentTool: Tool;
  isPanning: boolean;
  useTexture: boolean;
  textureScale: number;
}

class PhotonMixerApp {
  private renderer: Awaited<ReturnType<typeof initRenderer>> | null = null;
  private penInput: PenInputManager | null = null;
  private stabilizer: Stabilizer;
  private interpolator: Interpolator;
  private strokeManager: StrokeManager;
  // レイヤーごとの Undo 履歴（Undo はアクティブレイヤーに作用）
  private layerHistories = new Map<string, StrokeHistory>();
  private renderPipeline: RenderPipeline | null = null;
  private viewport: Viewport;
  private perfMonitor: PerfMonitor;
  private state: AppState = {
    isDrawing: false,
    currentColor: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
    wetRatio: 0,
    mixMode: 'stamp',
    currentTool: 'brush',
    isPanning: false,
    useTexture: false,
    textureScale: 1.0,
  };

  private rawPoints: import('./pen/input.js').PointerPoint[] = [];
  private prevTool: Tool | null = null;

  // テクスチャブラシの元画像（プリセット保存で再利用するため保持）
  private currentTextureBitmap: ImageBitmap | null = null;

  // 引きずり混色（progressive）用: pen-down 時の committed スナップショット
  private committedSnapshot: { data: Uint16Array; bytesPerRow: number } | null = null;

  constructor() {
    this.stabilizer = new Stabilizer({ threshold: 1000, minAlpha: 0.3 });
    // spacing=1: 4x バッファでダウンサンプルするため 1px でも GPU 負荷は低く品質が高い
    // 半透明ブラシで点線にならないためスタンプを密に配置する
    this.interpolator = new Interpolator({ spacing: 1, speedThreshold: 2000 });
    this.strokeManager = new StrokeManager({ baseSize: 2, maxSize: 20, curve: 'smooth' });
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
    });

    console.log('PhotonMixer initialized (waiting for canvas creation)');
  }

  private createNewCanvas(width: number, height: number): void {
    if (!this.renderPipeline) return;
    this.renderPipeline.resizeCanvasSize(width, height);
    this.viewport.reset(width, height, window.innerWidth, window.innerHeight);
    const transform = this.viewport.getTransform();
    this.renderPipeline.updateViewport(transform.scale, transform.offsetX, transform.offsetY, transform.rotation);
    this.layerHistories.clear();
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

  /**
   * レイヤーパネルを現在の状態から再構築する
   * 上が前面になるようリスト逆順で表示
   */
  private rebuildLayerPanel(): void {
    const list = document.getElementById('layer-list');
    if (!list || !this.renderPipeline) return;
    const layers = this.renderPipeline.getLayers();
    const activeId = this.renderPipeline.getActiveLayerId();
    const blendModes: { v: string; label: string }[] = [
      { v: 'normal', label: '通常' },
      { v: 'multiply', label: '乗算' },
      { v: 'screen', label: 'スクリーン' },
      { v: 'overlay', label: 'オーバーレイ' },
      { v: 'add', label: '加算' },
    ];

    list.innerHTML = '';
    // 前面（配列末尾）が上に来るよう逆順
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      const isActive = layer.id === activeId;
      const row = document.createElement('div');
      row.style.cssText = `padding: 5px 8px; border-bottom: 1px solid #333; cursor: pointer; ${isActive ? 'background:#1c3a1c;' : ''}`;
      row.addEventListener('click', () => {
        this.renderPipeline?.setActiveLayer(layer.id);
        this.rebuildLayerPanel();
      });

      // 1行目: 表示トグル + 名前
      const top = document.createElement('div');
      top.style.cssText = 'display:flex; align-items:center; gap:6px;';
      const eye = document.createElement('span');
      eye.textContent = layer.visible ? '👁' : '—';
      eye.style.cssText = 'cursor:pointer; width:16px;';
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        this.renderPipeline?.setLayerVisible(layer.id, !layer.visible);
        this.rebuildLayerPanel();
      });
      const nameEl = document.createElement('span');
      nameEl.textContent = layer.name;
      nameEl.style.cssText = 'flex:1; color:' + (isActive ? '#9f9' : '#ccc');
      top.appendChild(eye);
      top.appendChild(nameEl);

      // 2行目: 合成モード + 不透明度
      const ctl = document.createElement('div');
      ctl.style.cssText = 'display:flex; align-items:center; gap:4px; margin-top:3px;';
      const sel = document.createElement('select');
      sel.style.cssText = 'flex:1; background:#1a1a1a; color:#fff; border:1px solid #444; font-family:monospace; font-size:10px;';
      for (const m of blendModes) {
        const opt = document.createElement('option');
        opt.value = m.v; opt.textContent = m.label;
        if (m.v === layer.blendMode) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('click', (e) => e.stopPropagation());
      sel.addEventListener('change', () => {
        this.renderPipeline?.setLayerBlendMode(layer.id, sel.value as any);
      });
      const op = document.createElement('input');
      op.type = 'range'; op.min = '0'; op.max = '100';
      op.value = Math.round(layer.opacity * 100).toString();
      op.style.cssText = 'width:60px;';
      op.addEventListener('click', (e) => e.stopPropagation());
      op.addEventListener('input', () => {
        this.renderPipeline?.setLayerOpacity(layer.id, parseInt(op.value) / 100);
      });
      ctl.appendChild(sel);
      ctl.appendChild(op);

      row.appendChild(top);
      row.appendChild(ctl);
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
      const layers = await this.renderPipeline.readAllLayers();
      const activeId = this.renderPipeline.getActiveLayerId();
      const blob = savePmx(width, height, layers, activeId);
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
      const { width, height, activeId, layers } = await loadPmx(file);
      this.renderPipeline.loadLayers(width, height, layers, activeId);
      // ビューポートを作り直したキャンバスに合わせて再配置
      this.viewport.reset(width, height, window.innerWidth, window.innerHeight);
      const t = this.viewport.getTransform();
      this.renderPipeline.updateViewport(t.scale, t.offsetX, t.offsetY, t.rotation);
      // 履歴はピクセルから復元できないためクリア（読込後の Undo は不可）
      this.layerHistories.clear();
      this.rebuildLayerPanel();
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

  private isProgressiveMixing(): boolean {
    return this.state.mixMode === 'progressive' && this.state.wetRatio > 0;
  }

  private handlePenInput(event: import('./pen/input.js').PenInputEvent): void {
    if (this.state.isPanning) return;

    const { type, point } = event;

    // スクリーン座標 -> キャンバス座標
    const { x, y } = this.viewport.toCanvas(point.x, point.y);
    const transformedPoint = { ...point, x, y };

    switch (type) {
      case 'down': {
        if (this.state.currentTool === 'spoit') {
          this.handleSpoit(transformedPoint.x, transformedPoint.y);
          return;
        }
        if (this.state.currentTool === 'bucket') {
          this.handleBucketFill(transformedPoint.x, transformedPoint.y);
          return;
        }

        this.state.isDrawing = true;
        this.rawPoints = [transformedPoint];

        // 消しゴムモードならパイプライン切り替え
        this.renderPipeline?.setEraseMode(this.state.currentTool === 'eraser');

        if (this.isProgressiveMixing()) {
          // 点ごとの色を使うモードに切り替えてスナップショットを非同期取得
          this.renderPipeline?.updateBrushConfig({ usePointColor: true });
          this.committedSnapshot = null;
          this.renderPipeline?.requestCommittedSnapshot().then(snap => {
            this.committedSnapshot = snap;
          });
        }
        break;
      }

      case 'move': {
        if (!this.state.isDrawing) return;
        this.rawPoints.push(transformedPoint);

        if (this.isProgressiveMixing()) {
          this.handleProgressiveMove();
        } else {
          this.handleStampMove();
        }

        const inputId = this.perfMonitor.recordInput();
        this.perfMonitor.recordRender(inputId);
        break;
      }

      case 'up': {
        if (!this.state.isDrawing) return;

        const erase = this.state.currentTool === 'eraser';
        if (this.isProgressiveMixing()) {
          // 色付きの全点を over blend で committed へ確定（別ストロークと正しく合成）
          const colored = this.buildColoredStroke();
          if (colored.length > 0) {
            this.renderPipeline?.commitStroke(colored);
            this.activeHistory().addRecord({ kind: 'stroke', points: colored, erase });
          }
          // 点ごとの色モードを解除
          this.renderPipeline?.updateBrushConfig({ usePointColor: false });
        } else {
          const stabilized = this.stabilizer.stabilizeBatch(this.rawPoints);
          const interpolated = this.interpolator.interpolate(stabilized);
          const finalStroke = this.strokeManager.finalizeStroke(interpolated);
          if (finalStroke.length > 0) {
            // rebake 時に色を忠実に再現するため、各点に現在のブラシ色を焼き込む
            this.bakeColorIntoPoints(finalStroke);
            this.renderPipeline?.commitStroke(finalStroke);
            this.activeHistory().addRecord({ kind: 'stroke', points: finalStroke, erase });
          }
        }

        this.committedSnapshot = null;
        this.state.isDrawing = false;
        this.rawPoints = [];
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
      this.renderPipeline?.updateViewport(transform.scale, transform.offsetX, transform.offsetY, transform.rotation);
      this.updateZoomDisplay();
    }, { passive: false });

    // パン操作 (Space + ドラッグ)
    let lastX = 0;
    let lastY = 0;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        this.state.isPanning = true;
        canvas.style.cursor = 'grab';
      }
      // Undo/Redo
      if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        if (this.activeHistory().undo()) {
          this.renderPipeline?.rebakeFromRecords(this.activeHistory().getAllRecords());
        }
      }
      if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault();
        if (this.activeHistory().redo()) {
          this.renderPipeline?.rebakeFromRecords(this.activeHistory().getAllRecords());
        }
      }
      // ツール切り替えショートカット
      if (e.key === 'b') this.setTool('brush');
      if (e.key === 'e') this.setTool('eraser');
      if (e.key === 'i') this.setTool('spoit');
      if (e.key === 'g') this.setTool('bucket');
      if (e.key === 'r') {
        // R キーで回転リセット
        e.preventDefault();
        this.viewport.resetRotation();
        const transform = this.viewport.getTransform();
        this.renderPipeline?.updateViewport(transform.scale, transform.offsetX, transform.offsetY, transform.rotation);
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
        canvas.style.cursor = 'crosshair';
      }
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
        this.renderPipeline?.updateViewport(transform.scale, transform.offsetX, transform.offsetY, transform.rotation);
        lastX = e.clientX;
        lastY = e.clientY;
      }
    });
  }

  private setTool(tool: Tool): void {
    this.state.currentTool = tool;
    const tools: Tool[] = ['brush', 'eraser', 'spoit', 'bucket'];
    tools.forEach(t => {
      const btn = document.getElementById(`tool-${t}`);
      if (btn) btn.classList.toggle('active', t === tool);
    });
  }

  private async handleSpoit(x: number, y: number): Promise<void> {
    if (!this.renderPipeline) return;
    const snap = await this.renderPipeline.requestCommittedSnapshot();
    const { width, height } = this.viewport.getCanvasSize();
    const c = sampleSnapshot(snap.data, x, y, width, height, snap.bytesPerRow);
    // committed はプリマルチプライドαなので straight color に戻す（α=0 は透明＝拾わない）
    if (c.a < 0.001) return;
    this.updateCurrentColor({ r: c.r / c.a, g: c.g / c.a, b: c.b / c.a, a: 1 });
  }

  private updateCurrentColor(color: LinearColor): void {
    this.state.currentColor = { ...color };
    const srgb = linearColorToSrgb(color);
    const hex = '#' + [srgb.r, srgb.g, srgb.b].map(v =>
      Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
    ).join('');

    const colorPicker = document.getElementById('brush-color') as HTMLInputElement;
    if (colorPicker) colorPicker.value = hex;
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

    const targetColor = this.state.currentColor;

    // committed はプリマルチプライドαなので RGB を α 倍して書き込む
    const ta = targetColor.a;
    const target16 = new Uint16Array([
      float32ToFloat16(targetColor.r * ta),
      float32ToFloat16(targetColor.g * ta),
      float32ToFloat16(targetColor.b * ta),
      float32ToFloat16(ta),
    ]);

    const start16 = new Uint16Array([
      data[iy * uint16sPerRow + ix * 4],
      data[iy * uint16sPerRow + ix * 4 + 1],
      data[iy * uint16sPerRow + ix * 4 + 2],
      data[iy * uint16sPerRow + ix * 4 + 3],
    ]);

    // 色が同じなら何もしない
    if (target16.every((v, i) => v === start16[i])) return;

    // シンプルなシードフィル (スキャンライン)
    const stack: [number, number][] = [[ix, iy]];
    const processed = new Uint8Array(width * height);
    
    while (stack.length > 0) {
      const [cx, cy] = stack.pop()!;
      let lx = cx;
      while (lx > 0 && this.isSameColor(data, lx - 1, cy, start16, uint16sPerRow)) {
        lx--;
      }
      let rx = cx;
      while (rx < width - 1 && this.isSameColor(data, rx + 1, cy, start16, uint16sPerRow)) {
        rx++;
      }

      for (let i = lx; i <= rx; i++) {
        const idx = cy * uint16sPerRow + i * 4;
        data[idx] = target16[0];
        data[idx + 1] = target16[1];
        data[idx + 2] = target16[2];
        data[idx + 3] = target16[3];
        processed[cy * width + i] = 1;

        if (cy > 0 && !processed[(cy - 1) * width + i] && this.isSameColor(data, i, cy - 1, start16, uint16sPerRow)) {
          stack.push([i, cy - 1]);
        }
        if (cy < height - 1 && !processed[(cy + 1) * width + i] && this.isSameColor(data, i, cy + 1, start16, uint16sPerRow)) {
          stack.push([i, cy + 1]);
        }
      }
    }

    this.renderPipeline.updateCommittedTexture(data);
    // 塗りつぶし直後のスナップショットを履歴に積む（rebake で上書き再現＝Undo 可能）
    this.activeHistory().addRecord({ kind: 'fill', snapshot: data, bytesPerRow: snap.bytesPerRow });
  }

  private isSameColor(data: Uint16Array, x: number, y: number, ref16: Uint16Array, uint16sPerRow: number): boolean {
    const idx = y * uint16sPerRow + x * 4;
    // 許容誤差 (Tolerance) は一旦 0
    return data[idx] === ref16[0] && data[idx + 1] === ref16[1] && data[idx + 2] === ref16[2] && data[idx + 3] === ref16[3];
  }

  /**
   * 引きずり混色の move 処理
   * ストローク全体を色付きで再構築してライブプレビュー（isolated に毎フレーム描画）
   */
  private handleProgressiveMove(): void {
    const colored = this.buildColoredStroke();
    this.renderPipeline?.setCurrentStroke(colored);
    this.perfMonitor.setPoints(colored.length);
  }

  /**
   * ストローク全体を補間し、各点に「引きずり混色」の色を焼き込んで返す
   *
   * smudge と deposit を分離したモデル:
   *   smudge  : 動きながら既存色を拾っていく running color（筆に付いた絵の具）
   *   deposit : 実際に置く色 = mix(ブラシ色, smudge, wet)
   *             → ブラシ色を常に (1-wet) で再注入するので選択色が消えない
   *
   * 各点で:
   *   1. smudge を移動距離に応じて既存色へドリフト（空白上ではブラシ色へ戻る）
   *   2. deposit = ブラシ色と smudge を wet で補間
   * 点ごとに色を持たせるため継ぎ目も色の階段も生じない
   */
  private buildColoredStroke(): StrokePoint[] {
    const stabilized = this.stabilizer.stabilizeBatch(this.rawPoints);
    const interpolated = this.interpolator.interpolate(stabilized);
    const stroke = this.strokeManager.finalizeStroke(interpolated);
    if (stroke.length === 0) return stroke;

    const orig = this.state.currentColor;
    const wet = this.state.wetRatio;
    const snap = this.committedSnapshot;
    const canvas = this.renderer!.canvas;

    // smudge が既存色/ブラシ色へドリフトする e-fold 距離（px）。小さいほど速く拾う
    const SMUDGE_LEN = 25;
    const origOklab = linearToOklab(orig);

    let smudge: LinearColor = { ...orig };
    let prevX = stroke[0].x;
    let prevY = stroke[0].y;

    for (const p of stroke) {
      const dx = p.x - prevX, dy = p.y - prevY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      prevX = p.x; prevY = p.y;
      const rate = 1 - Math.exp(-dist / SMUDGE_LEN);

      // ① smudge をドリフト
      let targetOklab = origOklab; // 空白上はブラシ色へ戻る
      let driftT = rate;
      if (snap) {
        const cc = sampleSnapshot(snap.data, p.x, p.y, canvas.width, canvas.height, snap.bytesPerRow);
        if (cc.a > 0.001) {
          // 既存色を拾う（薄い既存色は弱く拾う）
          targetOklab = linearToOklab({ r: cc.r / cc.a, g: cc.g / cc.a, b: cc.b / cc.a, a: 1 });
          driftT = rate * cc.a;
        }
      }
      if (driftT > 0) {
        const s = oklabToLinear(mixOklab(linearToOklab(smudge), targetOklab, driftT));
        smudge = { r: s.r, g: s.g, b: s.b, a: orig.a };
      }

      // ② deposit = ブラシ色と smudge を wet で補間（ブラシ色を常に再注入）
      const dep = oklabToLinear(mixOklab(origOklab, linearToOklab(smudge), wet));
      p.color = { r: dep.r, g: dep.g, b: dep.b, a: orig.a };
    }

    return stroke;
  }

  /**
   * スタンプモードの move 処理（従来通り全点をライブプレビュー）
   */
  private handleStampMove(): void {
    const stabilized  = this.stabilizer.stabilizeBatch(this.rawPoints);
    const interpolated = this.interpolator.interpolate(stabilized);
    const liveStroke  = this.strokeManager.finalizeStroke(interpolated);
    this.renderPipeline?.setCurrentStroke(liveStroke);
    this.perfMonitor.setPoints(liveStroke.length);
  }

  /**
   * 各点に現在のブラシ色を焼き込む（Undo/Redo の rebake で色を忠実に再現するため）
   */
  private bakeColorIntoPoints(points: StrokePoint[]): void {
    const c = this.state.currentColor;
    for (const p of points) {
      if (!p.color) p.color = { r: c.r, g: c.g, b: c.b, a: c.a };
    }
  }

  private setupControls(): void {
    const brushBtn = document.getElementById('tool-brush');
    const eraserBtn = document.getElementById('tool-eraser');
    const spoitBtn = document.getElementById('tool-spoit');
    const bucketBtn = document.getElementById('tool-bucket');
    
    brushBtn?.addEventListener('click', () => this.setTool('brush'));
    eraserBtn?.addEventListener('click', () => this.setTool('eraser'));
    spoitBtn?.addEventListener('click', () => this.setTool('spoit'));
    bucketBtn?.addEventListener('click', () => this.setTool('bucket'));

    const sizeSlider    = document.getElementById('brush-size')    as HTMLInputElement;
    const sizeNum       = document.getElementById('brush-size-num') as HTMLInputElement;
    const alphaSlider   = document.getElementById('brush-alpha')   as HTMLInputElement;
    const alphaVal      = document.getElementById('brush-alpha-val')!;
    const wetSlider     = document.getElementById('brush-wet')     as HTMLInputElement;
    const wetVal        = document.getElementById('brush-wet-val')!;
    const colorPicker   = document.getElementById('brush-color')   as HTMLInputElement;
    const mixModeSelect = document.getElementById('mix-mode')      as HTMLSelectElement;
    const clearBtn      = document.getElementById('clear-btn')!;

    // ブラシサイズ同期ヘルパー
    const updateBrushSize = (size: number) => {
      const clamped = Math.max(1, Math.min(100, size));
      sizeSlider.value = clamped.toString();
      sizeNum.value = clamped.toString();
      const maxSize = clamped;
      const baseSize = Math.max(1, Math.round(maxSize * 0.1));
      this.strokeManager.updatePressureConfig({ maxSize, baseSize });
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
      const alpha = parseInt(alphaSlider.value) / 100;
      alphaVal.textContent = alphaSlider.value;
      this.state.currentColor.a = alpha;
      this.renderPipeline?.updateBrushConfig({ color: { ...this.state.currentColor } });
    });

    wetSlider.addEventListener('input', () => {
      this.state.wetRatio = parseInt(wetSlider.value) / 100;
      wetVal.textContent  = wetSlider.value;
      this.renderPipeline?.updateBrushConfig({ wetRatio: this.state.wetRatio });
    });

    colorPicker.addEventListener('input', () => {
      const hex = colorPicker.value;
      this.state.currentColor.r = srgbToLinear(parseInt(hex.substring(1, 3), 16) / 255);
      this.state.currentColor.g = srgbToLinear(parseInt(hex.substring(3, 5), 16) / 255);
      this.state.currentColor.b = srgbToLinear(parseInt(hex.substring(5, 7), 16) / 255);
      this.renderPipeline?.updateBrushConfig({ color: { ...this.state.currentColor } });
    });

    mixModeSelect.addEventListener('change', () => {
      this.state.mixMode = mixModeSelect.value as BrushMixMode;
      this.renderPipeline?.updateBrushConfig({ mixMode: this.state.mixMode });
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
    });
    document.getElementById('layer-del')?.addEventListener('click', () => {
      const id = this.renderPipeline?.getActiveLayerId();
      this.renderPipeline?.removeActiveLayer();
      if (id) this.layerHistories.delete(id);
      this.rebuildLayerPanel();
    });
    document.getElementById('layer-up')?.addEventListener('click', () => {
      this.renderPipeline?.moveActiveLayer('up');
      this.rebuildLayerPanel();
    });
    document.getElementById('layer-down')?.addEventListener('click', () => {
      this.renderPipeline?.moveActiveLayer('down');
      this.rebuildLayerPanel();
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
      this.state.textureScale = scale;
      this.renderPipeline?.updateBrushConfig({ textureScale: scale });
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
    };
  }

  /**
   * ブラシ設定を適用
   */
  private applyBrushConfig(config: BrushConfig): void {
    // 色を適用
    this.updateCurrentColor(config.color);

    // 不透明度スライダーを更新
    const alphaSlider = document.getElementById('brush-alpha') as HTMLInputElement;
    const alphaVal = document.getElementById('brush-alpha-val')!;
    const alpha = Math.round(config.color.a * 100);
    alphaSlider.value = alpha.toString();
    alphaVal.textContent = alpha.toString();

    // にじみスライダーを更新
    const wetSlider = document.getElementById('brush-wet') as HTMLInputElement;
    const wetVal = document.getElementById('brush-wet-val')!;
    const wet = Math.round(config.wetRatio * 100);
    wetSlider.value = wet.toString();
    wetVal.textContent = wet.toString();
    this.state.wetRatio = config.wetRatio;

    // 方式セレクトを更新
    const mixModeSelect = document.getElementById('mix-mode') as HTMLSelectElement;
    mixModeSelect.value = config.mixMode;
    this.state.mixMode = config.mixMode;

    // テクスチャスケールを更新
    const textureScaleSlider = document.getElementById('texture-scale') as HTMLInputElement;
    const textureScaleVal = document.getElementById('texture-scale-val')!;
    textureScaleSlider.value = config.textureScale.toString();
    textureScaleVal.textContent = config.textureScale.toString();
    this.state.textureScale = config.textureScale;

    // RenderPipeline に適用
    this.renderPipeline?.updateBrushConfig(config);
  }

  private handleResize(): void {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    if (!canvas || !this.renderPipeline) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    this.renderPipeline.resizeScreenSize(window.innerWidth, window.innerHeight);
    // リサイズ後もビューポートを更新
    const transform = this.viewport.getTransform();
    this.renderPipeline.updateViewport(transform.scale, transform.offsetX, transform.offsetY, transform.rotation);
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
