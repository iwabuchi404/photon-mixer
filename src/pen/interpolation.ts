/**
 * Catmull-Rom スプライン補間
 * 入力点間の滑らかな補間点を生成
 */

import type { PointerPoint } from './input.js';

/**
 * 補間設定
 */
export interface InterpolationConfig {
  spacing: number;       // 基本補間間隔（px）
  speedThreshold: number; // 高速判定閾値（px/sec）
}

/**
 * デフォルト設定
 */
const DEFAULT_CONFIG: InterpolationConfig = {
  spacing: 4,        // 4px間隔で補間
  speedThreshold: 2000, // 2000px/sec以上で高速とみなす
};

/**
 * Catmull-Rom 補間クラス
 */
export class Interpolator {
  private config: InterpolationConfig;

  constructor(config: Partial<InterpolationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 点列間を補間
   * @param points 入力点列（少なくとも2点必要）
   * @returns 補間された点列
   */
  interpolate(points: PointerPoint[]): PointerPoint[] {
    if (points.length < 2) {
      return points; // 補間不可
    }

    const result: PointerPoint[] = [points[0]];

    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];

      // 区間の速度を計算
      const velocity = this.calculateVelocity(p1, p2);
      const isHighSpeed = velocity > this.config.speedThreshold;

      // 高速時は予測描画用の仮点を追加
      if (isHighSpeed && i === points.length - 2) {
        // 最後の区間のみ先端予測
        const predictedPoints = this.interpolateSegment(
          p1,
          p2,
          p3,
          p2, // p3は次の点がないのでp2で代用
          true,
        );
        result.push(...predictedPoints);
      } else {
        // 通常の補間
        const segmentPoints = this.interpolateSegment(p0, p1, p2, p3, false);
        result.push(...segmentPoints.slice(1)); // 最初の点は重複するのでスキップ
      }
    }

    return result;
  }

  /**
   * 単一区間の補間
   */
  private interpolateSegment(
    p0: PointerPoint,
    p1: PointerPoint,
    p2: PointerPoint,
    p3: PointerPoint,
    predict: boolean,
  ): PointerPoint[] {
    const result: PointerPoint[] = [];
    const distance = Math.sqrt(
      (p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2,
    );

    // 補間点数を決定
    const numPoints = Math.max(2, Math.floor(distance / this.config.spacing));

    // i <= numPoints にして終点(t=1.0)を含める
    // i < numPoints だと終点が欠け、セグメント境界で gap = 2×spacing になっていた
    for (let i = 0; i <= numPoints; i++) {
      const t = i / numPoints;
      const point = this.catmullRom(p0, p1, p2, p3, t, p1, p2, predict);
      result.push(point);
    }

    return result;
  }

  /**
   * Catmull-Rom スプライン計算
   * P(t) = 0.5 * ((2*P1) + (-P0 + P2)*t + (2*P0 - 5*P1 + 4*P2 - P3)*t^2 + (-P0 + 3*P1 - 3*P2 + P3)*t^3)
   */
  private catmullRom(
    p0: PointerPoint,
    p1: PointerPoint,
    p2: PointerPoint,
    p3: PointerPoint,
    t: number,
    startPoint: PointerPoint,
    endPoint: PointerPoint,
    predict: boolean,
  ): PointerPoint {
    // 予測モードの場合、p3を仮想的に生成
    if (predict) {
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      p3 = {
        x: p2.x + dx,
        y: p2.y + dy,
        pressure: p2.pressure,
        tiltX: p2.tiltX,
        tiltY: p2.tiltY,
        timestamp: p2.timestamp + (p2.timestamp - p1.timestamp),
      };
    }

    const t2 = t * t;
    const t3 = t2 * t;

    // Catmull-Rom の係数
    const c0 = -0.5 * t3 + t2 - 0.5 * t;
    const c1 = 1.5 * t3 - 2.5 * t2 + 1.0;
    const c2 = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
    const c3 = 0.5 * t3 - 0.5 * t2;

    // 位置の計算
    const x = c0 * p0.x + c1 * p1.x + c2 * p2.x + c3 * p3.x;
    const y = c0 * p0.y + c1 * p1.y + c2 * p2.y + c3 * p3.y;

    // 筆圧・傾きは線形補間
    const pressure = this.lerp(p1.pressure, p2.pressure, t);
    const tiltX = this.lerp(p1.tiltX, p2.tiltX, t);
    const tiltY = this.lerp(p1.tiltY, p2.tiltY, t);

    // タイムスタンプは線形補間
    const timestamp = this.lerp(p1.timestamp, p2.timestamp, t);

    return { x, y, pressure, tiltX, tiltY, timestamp };
  }

  /**
   * 線形補間
   */
  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
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
    return (distance / dt) * 1000;
  }

  /**
   * 設定を取得
   */
  getConfig(): InterpolationConfig {
    return { ...this.config };
  }

  /**
   * 設定を更新
   */
  updateConfig(config: Partial<InterpolationConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
