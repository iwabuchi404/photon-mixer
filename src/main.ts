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

  // 引きずり混色（progressive）用
  private brushHeadColor: LinearColor | null = null;
  private committedSnapshot: { data: Uint16Array; bytesPerRow: number } | null = null;
  // move ごとにコミット済みの補間点数を追跡（スタンプの重複防止）
  private progressiveLastInterpCount = 0;

  constructor() {
    this.stabilizer = new Stabilizer({ threshold: 1000, minAlpha: 0.3 });
    this.interpolator = new Interpolator({ spacing: 4, speedThreshold: 2000 });
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
        this.progressiveLastInterpCount = 0;

        if (this.isProgressiveMixing()) {
          // 筆先色を初期化してスナップショットを非同期取得
          this.brushHeadColor = { ...this.state.currentColor };
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

        if (this.isProgressiveMixing() && this.brushHeadColor !== null) {
          this.handleProgressiveMove(point.x, point.y);
        } else {
          this.handleStampMove();
        }

        const inputId = this.perfMonitor.recordInput();
        this.perfMonitor.recordRender(inputId);
        break;
      }

      case 'up': {
        if (!this.state.isDrawing) return;

        if (this.isProgressiveMixing() && this.brushHeadColor !== null) {
          // 残った末端点をコミット
          this.commitProgressiveSegment();
          // ブラシ色を元に戻す
          this.renderPipeline?.updateBrushConfig({ color: { ...this.state.currentColor } });
        } else {
          const stabilized = this.stabilizer.stabilizeBatch(this.rawPoints);
          const interpolated = this.interpolator.interpolate(stabilized);
          const finalStroke = this.strokeManager.finalizeStroke(interpolated);
          if (finalStroke.length > 0) {
            this.renderPipeline?.commitStroke(finalStroke);
          }
        }

        this.brushHeadColor = null;
        this.committedSnapshot = null;
        this.progressiveLastInterpCount = 0;
        this.state.isDrawing = false;
        this.rawPoints = [];
        break;
      }
    }
  }

  /**
   * 引きずり混色の move 処理
   * ① brushHeadColor を進化させる
   * ② 新しい補間点のみ即座にコミット（焼き付け）
   * → 各点が描かれた瞬間の brushHeadColor で記録される
   */
  private handleProgressiveMove(x: number, y: number): void {
    // ① brushHeadColor を進化させて GPU に送る
    this.evolveProgressiveMixing(x, y);

    // ② 新しい補間点をコミット
    this.commitProgressiveSegment();

    // committed が最新なのでライブプレビューは不要
    this.renderPipeline?.setCurrentStroke([]);
    this.perfMonitor.setPoints(this.progressiveLastInterpCount);
  }

  /**
   * brushHeadColor を現在座標のキャンバス色と混合して進化させる
   */
  private evolveProgressiveMixing(x: number, y: number): void {
    if (!this.brushHeadColor) return;

    if (this.committedSnapshot) {
      const canvas = this.renderer!.canvas;
      const canvasColor = sampleSnapshot(
        this.committedSnapshot.data, x, y,
        canvas.width, canvas.height,
        this.committedSnapshot.bytesPerRow,
      );

      if (canvasColor.a > 0.001) {
        const brushOklab  = linearToOklab(this.brushHeadColor);
        // アンプリマルチプライドして Oklab 変換
        const canvasLinear: LinearColor = {
          r: canvasColor.r / canvasColor.a,
          g: canvasColor.g / canvasColor.a,
          b: canvasColor.b / canvasColor.a,
          a: 1,
        };
        const canvasOklab = linearToOklab(canvasLinear);
        const t = this.state.wetRatio * canvasColor.a;
        const mixed = mixOklab(brushOklab, canvasOklab, t);
        const mixedLinear = oklabToLinear(mixed);
        this.brushHeadColor = {
          r: mixedLinear.r,
          g: mixedLinear.g,
          b: mixedLinear.b,
          a: this.state.currentColor.a,
        };
      }
    }

    // 常に GPU の brush_color を更新（スナップショット未取得時は currentColor のまま）
    this.renderPipeline?.updateBrushConfig({ color: { ...this.brushHeadColor } });
  }

  /**
   * 最後のコミット以降の新しい補間点をコミットする
   */
  private commitProgressiveSegment(): void {
    const stabilized   = this.stabilizer.stabilizeBatch(this.rawPoints);
    const allInterp    = this.interpolator.interpolate(stabilized);
    const allStroke    = this.strokeManager.finalizeStroke(allInterp);
    const newSegment   = allStroke.slice(this.progressiveLastInterpCount);

    if (newSegment.length > 0) {
      this.renderPipeline?.commitStroke(newSegment);
      this.progressiveLastInterpCount = allStroke.length;
    }
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
      this.interpolator.updateConfig({ spacing: Math.max(1, Math.round(maxSize * 0.2)) });
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
