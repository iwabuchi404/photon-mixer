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
  /** 速度計算用。補正結果ではなく直前の生入力を保持する。 */
  private lastRawPoint: PointerPoint | null = null;
  /** EMAの直前出力。 */
  private lastOutputPoint: PointerPoint | null = null;
  /** 平滑化済み筆圧の直前値。 */
  private lastPressure: number | null = null;
  private lastVelocity: number = 0;
  private static readonly NOMINAL_INTERVAL_MS = 1000 / 120;

  constructor(config: Partial<StabilizationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 単一の点を補正
   */
  stabilize(point: PointerPoint): PointerPoint {
    // 最初の点はそのまま返す
    if (!this.lastRawPoint || !this.lastOutputPoint) {
      this.lastRawPoint = point;
      this.lastOutputPoint = point;
      this.lastPressure = point.pressure;
      return point;
    }

    // 速度は補正済みの遅れた点ではなく、生入力点同士から計算する。
    const velocity = this.calculateVelocity(this.lastRawPoint, point);
    this.lastVelocity = velocity;

    // 基準αをサンプル間隔に合わせて時間補正する。120Hz相当を基準にすることで、
    // 入力デバイスのサンプリング周波数が変わってもフィルターの時定数を保つ。
    const baseAlpha = this.calculateAlpha(velocity);
    const dt = Math.max(0, point.timestamp - this.lastRawPoint.timestamp);
    const alpha = this.timeAdjustedAlpha(baseAlpha, dt);

    // EMAフィルター適用
    // 筆圧も位置と同じαで均す。高速時は素通し、低速時は定常化する。
    // 生筆圧のままにするとセンサーノイズ＋量子化が太さの階段になり、
    // ゆっくり描くほどカクついて見える。
    const stabilized: PointerPoint = {
      x: this.ema(this.lastOutputPoint.x, point.x, alpha),
      y: this.ema(this.lastOutputPoint.y, point.y, alpha),
      pressure: this.lastPressure === null
        ? point.pressure
        : this.ema(this.lastPressure, point.pressure, alpha),
      tiltX: point.tiltX,
      tiltY: point.tiltY,
      timestamp: point.timestamp,
    };

    this.lastRawPoint = point;
    this.lastOutputPoint = stabilized;
    this.lastPressure = stabilized.pressure;
    return stabilized;
  }

  /**
   * 複数の点を補正（バッチ処理）
   */
  stabilizeBatch(points: PointerPoint[], finishAtLastInput = false): PointerPoint[] {
    this.reset(); // バッチ処理の前にリセット
    const result: PointerPoint[] = [];

    for (const point of points) {
      result.push(this.stabilize(point));
    }

    // ペンアップ確定時は、EMAの遅延で線が途中で止まらないよう最後の生入力へ収束させる。
    // 補正点を置換せず終端点を追加し、補間側が自然な接続を生成できるようにする。
    if (finishAtLastInput && points.length > 0 && result.length > 0) {
      const rawEnd = points[points.length - 1];
      const filteredEnd = result[result.length - 1];
      if (Math.hypot(rawEnd.x - filteredEnd.x, rawEnd.y - filteredEnd.y) > 0.01) {
        result.push({ ...rawEnd });
      }
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
    const ratio = this.config.threshold > 0 ? velocity / this.config.threshold : 1;
    return Math.max(this.config.minAlpha, Math.min(this.config.maxAlpha, ratio));
  }

  /**
   * 基準間隔におけるαを、実際の経過時間へ変換する。
   * 1 - (1 - α)^(dt / nominalDt) は、連続時間で同じ減衰率を保つ。
   */
  private timeAdjustedAlpha(baseAlpha: number, dtMs: number): number {
    if (baseAlpha >= 1) return 1;
    if (dtMs <= 0) return 0;
    const intervals = dtMs / Stabilizer.NOMINAL_INTERVAL_MS;
    return 1 - Math.pow(1 - baseAlpha, intervals);
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
    this.lastRawPoint = null;
    this.lastOutputPoint = null;
    this.lastPressure = null;
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
