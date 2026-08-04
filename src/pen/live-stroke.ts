/**
 * 長いストロークを一定の入力窓へ分割する。
 *
 * 手ブレ補正は入力ごとに増分適用し、補間だけを短い末尾窓へ掛ける。
 * 確定した prefix は呼び出し側が GPU の一筆用テクスチャへフラッシュする。
 */

import type { PointerPoint } from './input.js';
import type { Interpolator } from './interpolation.js';

export interface IncrementalStabilizer {
  stabilize(point: PointerPoint): PointerPoint | null;
  reset(): void;
}

export interface LiveStrokeWindowConfig {
  /** この生入力点数を超えたら prefix を確定する。 */
  maxRawPoints: number;
  /** この時間窓を超えたら prefix を確定する。 */
  maxDurationMs: number;
  /** この移動距離を超えたら prefix を確定する。 */
  maxDistancePx: number;
  /** Catmull-Rom の境界を安定させるため次の窓へ残す点数。 */
  overlapRawPoints: number;
}

export interface LiveStrokeUpdate {
  /** 今回新たに確定し、GPU accumulator と履歴へ追加できる点列。 */
  flushed: PointerPoint[];
  /** まだ変化し得る短いライブ末尾。 */
  tail: PointerPoint[];
}

const DEFAULT_CONFIG: LiveStrokeWindowConfig = {
  maxRawPoints: 64,
  maxDurationMs: 250,
  maxDistancePx: 512,
  overlapRawPoints: 4,
};

export class LiveStrokeProcessor {
  private readonly stabilizer: IncrementalStabilizer;
  private readonly interpolator: Interpolator;
  private readonly config: LiveStrokeWindowConfig;
  private rawTail: PointerPoint[] = [];
  private lastRaw: PointerPoint | null = null;
  private lastStabilized: PointerPoint | null = null;
  private tailDistance = 0;
  private active = false;

  constructor(
    stabilizer: IncrementalStabilizer,
    interpolator: Interpolator,
    config: Partial<LiveStrokeWindowConfig> = {},
  ) {
    this.stabilizer = stabilizer;
    this.interpolator = interpolator;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  begin(point: PointerPoint): LiveStrokeUpdate {
    this.reset();
    this.active = true;
    this.lastRaw = { ...point };
    const stabilized = this.stabilizer.stabilize(point) ?? point;
    this.lastStabilized = { ...stabilized };
    this.rawTail = [{ ...stabilized }];
    return { flushed: [], tail: this.interpolateTail() };
  }

  add(point: PointerPoint): LiveStrokeUpdate {
    if (!this.active) return this.begin(point);

    if (this.lastRaw) {
      this.tailDistance += Math.hypot(point.x - this.lastRaw.x, point.y - this.lastRaw.y);
    }
    this.lastRaw = { ...point };

    const stabilized = this.stabilizer.stabilize(point);
    if (stabilized) {
      this.lastStabilized = { ...stabilized };
      this.rawTail.push({ ...stabilized });
    }

    const processed = this.interpolateTail();
    if (!this.shouldFlush() || this.rawTail.length <= this.config.overlapRawPoints) {
      return { flushed: [], tail: processed };
    }

    const keepCount = Math.max(2, this.config.overlapRawPoints);
    const keepIndex = Math.max(1, this.rawTail.length - keepCount);
    const boundaryTime = this.rawTail[keepIndex].timestamp;
    let boundaryIndex = processed.findIndex(p => p.timestamp >= boundaryTime);
    if (boundaryIndex < 0) boundaryIndex = Math.max(0, processed.length - 1);

    // 境界点は prefix と tail の両方へ含める。GPU 側は一筆内 max 合成なので
    // 重複しても濃くならず、補間窓の境界に隙間を作らない。
    const flushed = processed.slice(0, boundaryIndex + 1);
    this.rawTail = this.rawTail.slice(keepIndex);
    this.recalculateTailDistance();

    return { flushed, tail: this.interpolateTail() };
  }

  /**
   * ペンアップ時の残りを返す。EMAで遅れた末尾は最後の生入力へ収束させる。
   */
  finish(transform?: (points: PointerPoint[]) => PointerPoint[]): PointerPoint[] {
    if (!this.active) return [];

    if (this.lastRaw && this.lastStabilized && Math.hypot(
      this.lastRaw.x - this.lastStabilized.x,
      this.lastRaw.y - this.lastStabilized.y,
    ) > 0.01) {
      this.rawTail.push({ ...this.lastRaw });
    }

    const source = this.rawTail.map(point => ({ ...point }));
    const tail = transform ? transform(source) : this.interpolator.interpolate(source);
    this.reset();
    return tail;
  }

  getLastRaw(): PointerPoint | null {
    return this.lastRaw ? { ...this.lastRaw } : null;
  }

  getBufferedRawCount(): number {
    return this.rawTail.length;
  }

  reset(): void {
    this.stabilizer.reset();
    this.rawTail = [];
    this.lastRaw = null;
    this.lastStabilized = null;
    this.tailDistance = 0;
    this.active = false;
  }

  private interpolateTail(): PointerPoint[] {
    return this.interpolator.interpolate(this.rawTail);
  }

  private shouldFlush(): boolean {
    if (this.rawTail.length >= this.config.maxRawPoints) return true;
    if (this.tailDistance >= this.config.maxDistancePx) return true;
    if (this.rawTail.length >= 2) {
      const duration = this.rawTail[this.rawTail.length - 1].timestamp - this.rawTail[0].timestamp;
      if (duration >= this.config.maxDurationMs) return true;
    }
    return false;
  }

  private recalculateTailDistance(): void {
    this.tailDistance = 0;
    for (let i = 1; i < this.rawTail.length; i++) {
      this.tailDistance += Math.hypot(
        this.rawTail[i].x - this.rawTail[i - 1].x,
        this.rawTail[i].y - this.rawTail[i - 1].y,
      );
    }
  }
}
