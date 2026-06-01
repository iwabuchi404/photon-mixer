/**
 * 手ブレ補正（Stabilization）
 * EMA（指数移動平均）フィルターによる平滑化
 */

import type { PointerPoint } from './input.js';

/**
 * 手ブレ補正の設定
 */
export interface StabilizationConfig {
  threshold: number;    // 速度閾値（px/sec）
  minAlpha: number;     // 最小α（低速時の強い補正）
  maxAlpha: number;     // 最大α（高速時の補正なしに近い）
}

/**
 * デフォルト設定
 */
const DEFAULT_CONFIG: StabilizationConfig = {
  threshold: 1000,      // 1000px/sec 以上でα=1
  minAlpha: 0.2,        // 低速時は20%の新しい値を反映
  maxAlpha: 1.0,        // 高速時は100%反映（補正なし）
};

/**
 * 手ブレ補正クラス
 */
export class Stabilizer {
  private config: StabilizationConfig;
  private lastPoint: PointerPoint | null = null;
  private lastVelocity: number = 0;

  constructor(config: Partial<StabilizationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 単一の点を補正
   */
  stabilize(point: PointerPoint): PointerPoint {
    // 最初の点はそのまま返す
    if (!this.lastPoint) {
      this.lastPoint = point;
      return point;
    }

    // 速度を計算
    const velocity = this.calculateVelocity(this.lastPoint, point);
    this.lastVelocity = velocity;

    // αを決定（速度に応じて）
    const alpha = this.calculateAlpha(velocity);

    // EMAフィルター適用
    const stabilized: PointerPoint = {
      x: this.ema(this.lastPoint.x, point.x, alpha),
      y: this.ema(this.lastPoint.y, point.y, alpha),
      pressure: point.pressure, // 筆圧は補正しない
      tiltX: point.tiltX,
      tiltY: point.tiltY,
      timestamp: point.timestamp,
    };

    this.lastPoint = stabilized;
    return stabilized;
  }

  /**
   * 複数の点を補正（バッチ処理）
   */
  stabilizeBatch(points: PointerPoint[]): PointerPoint[] {
    this.reset(); // バッチ処理の前にリセット
    const result: PointerPoint[] = [];

    for (const point of points) {
      result.push(this.stabilize(point));
    }

    return result;
  }

  /**
   * 速度を計算（px/sec）
   */
  private calculateVelocity(from: PointerPoint, to: PointerPoint): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const dt = to.timestamp - from.timestamp;

    if (dt <= 0) return 0;
    return (distance / dt) * 1000; // px/sec
  }

  /**
   * αを計算（速度に応じて動的に変化）
   * 低速時: 小さいα（強い補正）
   * 高速時: 大きいα（補正なし）
   */
  private calculateAlpha(velocity: number): number {
    // 速度 / 閾値で0-1の範囲に正規化
    const normalized = Math.min(velocity / this.config.threshold, 1.0);

    // minAlpha - maxAlpha の範囲にマッピング
    const alpha =
      this.config.minAlpha + normalized * (this.config.maxAlpha - this.config.minAlpha);

    return alpha;
  }

  /**
   * 指数移動平均（EMA）
   * new_value = α * current + (1 - α) * previous
   */
  private ema(previous: number, current: number, alpha: number): number {
    return alpha * current + (1 - alpha) * previous;
  }

  /**
   * 内部状態をリセット
   */
  reset(): void {
    this.lastPoint = null;
    this.lastVelocity = 0;
  }

  /**
   * 現在の設定を取得
   */
  getConfig(): StabilizationConfig {
    return { ...this.config };
  }

  /**
   * 設定を更新
   */
  updateConfig(config: Partial<StabilizationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 最後の速度を取得（デバッグ用）
   */
  getLastVelocity(): number {
    return this.lastVelocity;
  }
}
