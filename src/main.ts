/**
 * PhotonMixer Phase 1 メインエントリーポイント
 * ペン入力、補間、手ブレ補正、描画の統合
 */

import { initRenderer } from './core/renderer.js';
import { PenInputManager } from './pen/input.js';
import { Stabilizer } from './pen/stabilization.js';
import { Interpolator } from './pen/interpolation.js';
import { StrokeManager } from './pen/stroke.js';
import { RenderPipeline } from './render/pipeline.js';
import { PerfMonitor } from './ui/perf-monitor.js';

interface AppState {
  isDrawing: boolean;
}

class PhotonMixerApp {
  private renderer: Awaited<ReturnType<typeof initRenderer>> | null = null;
  private penInput: PenInputManager | null = null;
  private stabilizer: Stabilizer;
  private interpolator: Interpolator;
  private strokeManager: StrokeManager;
  private renderPipeline: RenderPipeline | null = null;
  private perfMonitor: PerfMonitor;
  private state: AppState = { isDrawing: false };

  // ペンダウンからペンアップまでの生入力点
  private rawPoints: import('./pen/input.js').PointerPoint[] = [];

  constructor() {
    this.stabilizer = new Stabilizer({ threshold: 1000, minAlpha: 0.3 });
    this.interpolator = new Interpolator({ spacing: 1, speedThreshold: 2000 });
    this.strokeManager = new StrokeManager({ baseSize: 2, maxSize: 20, curve: 'smooth' });
    this.perfMonitor = new PerfMonitor();
  }

  async init(): Promise<void> {
    console.log('PhotonMixer Phase 1 initializing...');

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

    console.log('PhotonMixer Phase 1 initialized');
  }

  private handlePenInput(event: import('./pen/input.js').PenInputEvent): void {
    const { type, point } = event;

    switch (type) {
      case 'down':
        this.state.isDrawing = true;
        this.rawPoints = [point];
        break;

      case 'move': {
        if (!this.state.isDrawing) return;
        this.rawPoints.push(point);

        // move ごとに全点を補間してライブプレビュー（点線にならない）
        const stabilized = this.stabilizer.stabilizeBatch(this.rawPoints);
        const interpolated = this.interpolator.interpolate(stabilized);
        const liveStroke = this.strokeManager.finalizeStroke(interpolated);
        this.renderPipeline?.setCurrentStroke(liveStroke);
        this.perfMonitor.setPoints(liveStroke.length);

        const inputId = this.perfMonitor.recordInput();
        this.perfMonitor.recordRender(inputId);
        break;
      }

      case 'up': {
        if (!this.state.isDrawing) return;

        // ペンアップ時に最終ストロークを確定
        const stabilized = this.stabilizer.stabilizeBatch(this.rawPoints);
        const interpolated = this.interpolator.interpolate(stabilized);
        const finalStroke = this.strokeManager.finalizeStroke(interpolated);
        if (finalStroke.length > 0) {
          this.renderPipeline?.commitStroke(finalStroke);
        }

        this.state.isDrawing = false;
        this.rawPoints = [];
        break;
      }
    }
  }

  /**
   * ブラシコントロール UI の初期化
   */
  private setupControls(): void {
    const sizeSlider = document.getElementById('brush-size') as HTMLInputElement;
    const sizeVal = document.getElementById('brush-size-val')!;
    const alphaSlider = document.getElementById('brush-alpha') as HTMLInputElement;
    const alphaVal = document.getElementById('brush-alpha-val')!;
    const clearBtn = document.getElementById('clear-btn')!;

    sizeSlider.addEventListener('input', () => {
      const maxSize = parseInt(sizeSlider.value);
      const baseSize = Math.max(1, Math.round(maxSize * 0.1));
      sizeVal.textContent = maxSize.toString();
      this.strokeManager.updatePressureConfig({ maxSize, baseSize });
    });

    alphaSlider.addEventListener('input', () => {
      const alpha = parseInt(alphaSlider.value) / 100;
      alphaVal.textContent = alphaSlider.value;
      this.renderPipeline?.updateBrushConfig({ color: { r: 1.0, g: 1.0, b: 1.0, a: alpha } });
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
