/**
 * パフォーマンス監視
 * FPS、レイテンシの計測と表示
 */

/**
 * パフォーマンス統計
 */
export interface PerfStats {
  fps: number;
  latency: number; // ミリ秒
  frameTime: number; // ミリ秒
  points: number; // 現在のストロークの点数
}

/**
 * パフォーマンスモニター
 */
export class PerfMonitor {
  private frameCount = 0;
  private lastFpsUpdate = 0;
  private currentFps = 0;
  private frameTimes: number[] = [];
  private inputTimestamps: Map<number, number> = new Map();
  private renderTimestamps: Map<number, number> = new Map();
  private currentPoints = 0;
  private nextId = 0;

  // DOM要素
  private fpsElement: HTMLElement;
  private latencyElement: HTMLElement;
  private pointsElement: HTMLElement;

  constructor() {
    this.fpsElement = document.getElementById('fps')!;
    this.latencyElement = document.getElementById('latency')!;
    this.pointsElement = document.getElementById('points')!;

    if (!this.fpsElement || !this.latencyElement || !this.pointsElement) {
      console.error('PerfMonitor: Required DOM elements not found');
    }
  }

  /**
   * フレーム開始時に呼ぶ
   */
  beginFrame(timestamp: number): void {
    // FPS計算
    this.frameCount++;
    if (timestamp - this.lastFpsUpdate >= 1000) {
      this.currentFps = Math.round((this.frameCount * 1000) / (timestamp - this.lastFpsUpdate));
      this.frameCount = 0;
      this.lastFpsUpdate = timestamp;
      this.updateDisplay();
    }
  }

  /**
   * フレーム終了時に呼ぶ
   */
  endFrame(timestamp: number): void {
    // フレーム時間を記録
    const now = performance.now();
    this.frameTimes.push(now);
    // 直近60フレーム（約1秒）を保持
    if (this.frameTimes.length > 60) {
      this.frameTimes.shift();
    }
  }

  /**
   * 入力イベントを記録
   */
  recordInput(): number {
    const id = this.nextId++;
    this.inputTimestamps.set(id, performance.now());
    return id;
  }

  /**
   * レンダリング完了を記録
   */
  recordRender(inputId: number): void {
    const inputTime = this.inputTimestamps.get(inputId);
    if (inputTime) {
      const renderTime = performance.now();
      this.renderTimestamps.set(inputId, renderTime - inputTime);
      this.inputTimestamps.delete(inputId);
    }
  }

  /**
   * 現在の統計を取得
   */
  getStats(): PerfStats {
    // 平均レイテンシ（直近10件）
    const latencies: number[] = [];
    let count = 0;
    for (const [inputId, renderTime] of this.renderTimestamps.entries()) {
      latencies.push(renderTime);
      if (++count >= 10) break;
    }

    const avgLatency =
      latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0;

    // 平均フレーム時間
    const avgFrameTime =
      this.frameTimes.length > 1
        ? (this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0]) /
          (this.frameTimes.length - 1)
        : 0;

    return {
      fps: this.currentFps,
      latency: Math.round(avgLatency),
      frameTime: Math.round(avgFrameTime * 1000) / 1000,
      points: this.currentPoints,
    };
  }

  /**
   * 点数を設定
   */
  setPoints(count: number): void {
    this.currentPoints = count;
    this.pointsElement.textContent = count.toString();
  }

  /**
   * 表示を更新
   */
  private updateDisplay(): void {
    const stats = this.getStats();
    this.fpsElement.textContent = stats.fps.toString();
    this.latencyElement.textContent = stats.latency.toString();

    // FPSに応じて色を変える
    if (stats.fps >= 55) {
      this.fpsElement.className = 'perf-value';
    } else if (stats.fps >= 30) {
      this.fpsElement.className = 'perf-warning';
    } else {
      this.fpsElement.className = 'perf-error';
    }

    // レイテンシに応じて色を変える
    if (stats.latency <= 20) {
      this.latencyElement.className = 'perf-value';
    } else if (stats.latency <= 40) {
      this.latencyElement.className = 'perf-warning';
    } else {
      this.latencyElement.className = 'perf-error';
    }
  }

  /**
   * 古いデータをクリア
   */
  cleanup(): void {
    // 1秒以上前のデータを削除
    const now = performance.now();
    for (const [id, time] of this.renderTimestamps.entries()) {
      if (now - time > 1000) {
        this.renderTimestamps.delete(id);
      }
    }
  }
}
