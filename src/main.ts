/**
 * PhotonMixer メインエントリーポイント
 */

import { initRenderer } from './core/renderer.js';
import { PenInputManager } from './pen/input.js';
import { Stabilizer } from './pen/stabilization.js';
import { Interpolator } from './pen/interpolation.js';
import { StrokeManager } from './pen/stroke.js';
import { RenderPipeline } from './render/pipeline.js';
import { PerfMonitor } from './ui/perf-monitor.js';
import { srgbToLinear } from './color/linear.js';
import { linearToOklab, oklabToLinear, mixOklab } from './color/oklab.js';
import type { LinearColor } from './color/types.js';
import type { StrokePoint } from './pen/stroke.js';
import type { BrushMixMode } from './render/brush.js';

// Float16（Uint16 表現）→ Float32 変換
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
}

class PhotonMixerApp {
  private renderer: Awaited<ReturnType<typeof initRenderer>> | null = null;
  private penInput: PenInputManager | null = null;
  private stabilizer: Stabilizer;
  private interpolator: Interpolator;
  private strokeManager: StrokeManager;
  private renderPipeline: RenderPipeline | null = null;
  private perfMonitor: PerfMonitor;
  private state: AppState = {
    isDrawing: false,
    currentColor: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
    wetRatio: 0,
    mixMode: 'stamp',
  };

  private rawPoints: import('./pen/input.js').PointerPoint[] = [];

  // 引きずり混色（progressive）用: pen-down 時の committed スナップショット
  private committedSnapshot: { data: Uint16Array; bytesPerRow: number } | null = null;

  constructor() {
    this.stabilizer = new Stabilizer({ threshold: 1000, minAlpha: 0.3 });
    // spacing=1: 4x バッファでダウンサンプルするため 1px でも GPU 負荷は低く品質が高い
    // 半透明ブラシで点線にならないためスタンプを密に配置する
    this.interpolator = new Interpolator({ spacing: 1, speedThreshold: 2000 });
    this.strokeManager = new StrokeManager({ baseSize: 2, maxSize: 20, curve: 'smooth' });
    this.perfMonitor = new PerfMonitor();
  }

  async init(): Promise<void> {
    console.log('PhotonMixer initializing...');

    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    if (!canvas) throw new Error('Canvas element not found');

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    try {
      this.renderer = await initRenderer(canvas);
      console.log('WebGPU initialized successfully');
    } catch (e) {
      console.error('Failed to initialize WebGPU:', e);
      alert('WebGPUの初期化に失敗しました。ブラウザがWebGPUに対応しているか確認してください。');
      return;
    }

    this.renderPipeline = new RenderPipeline(this.renderer);
    await this.renderPipeline.init();

    this.penInput = new PenInputManager(canvas);
    this.penInput.onPenInput((event) => this.handlePenInput(event));

    window.addEventListener('resize', () => this.handleResize());

    this.setupControls();
    this.startRenderLoop();

    console.log('PhotonMixer initialized');
  }

  private isProgressiveMixing(): boolean {
    return this.state.mixMode === 'progressive' && this.state.wetRatio > 0;
  }

  private handlePenInput(event: import('./pen/input.js').PenInputEvent): void {
    const { type, point } = event;

    switch (type) {
      case 'down': {
        this.state.isDrawing = true;
        this.rawPoints = [point];

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
        this.rawPoints.push(point);

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

        if (this.isProgressiveMixing()) {
          // 色付きの全点を over blend で committed へ確定（別ストロークと正しく合成）
          const colored = this.buildColoredStroke();
          if (colored.length > 0) {
            this.renderPipeline?.commitStroke(colored);
          }
          // 点ごとの色モードを解除
          this.renderPipeline?.updateBrushConfig({ usePointColor: false });
        } else {
          const stabilized = this.stabilizer.stabilizeBatch(this.rawPoints);
          const interpolated = this.interpolator.interpolate(stabilized);
          const finalStroke = this.strokeManager.finalizeStroke(interpolated);
          if (finalStroke.length > 0) {
            this.renderPipeline?.commitStroke(finalStroke);
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

  private setupControls(): void {
    const sizeSlider    = document.getElementById('brush-size')    as HTMLInputElement;
    const sizeVal       = document.getElementById('brush-size-val')!;
    const alphaSlider   = document.getElementById('brush-alpha')   as HTMLInputElement;
    const alphaVal      = document.getElementById('brush-alpha-val')!;
    const wetSlider     = document.getElementById('brush-wet')     as HTMLInputElement;
    const wetVal        = document.getElementById('brush-wet-val')!;
    const colorPicker   = document.getElementById('brush-color')   as HTMLInputElement;
    const mixModeSelect = document.getElementById('mix-mode')      as HTMLSelectElement;
    const clearBtn      = document.getElementById('clear-btn')!;

    sizeSlider.addEventListener('input', () => {
      const maxSize  = parseInt(sizeSlider.value);
      const baseSize = Math.max(1, Math.round(maxSize * 0.1));
      sizeVal.textContent = maxSize.toString();
      this.strokeManager.updatePressureConfig({ maxSize, baseSize });
      // spacing は 1 固定（サイズ変更で変えない。4x バッファで品質を確保）
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

    clearBtn.addEventListener('click', () => {
      this.renderPipeline?.clear();
    });
  }

  private handleResize(): void {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    if (!canvas || !this.renderPipeline) return;
    this.renderPipeline.resize(window.innerWidth, window.innerHeight);
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
