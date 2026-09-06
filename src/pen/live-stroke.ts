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
  /**
   * これまでに排出した補間点列（単調増加・不変）。
   * フラッシュで生入力窓を切り詰めても再計算で書き換えない。
   * 再計算の微差（0.1〜0.9px の逆行スパイク）が二重描画のギザつきになるため。
   */
  private emitted: PointerPoint[] = [];
  private emittedFlushedCount = 0;

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
    this.emitNew(this.interpolateTail());
    return { flushed: [], tail: this.displayTail() };
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

    this.emitNew(this.interpolateTail());
    if (!this.shouldFlush() || this.rawTail.length <= this.config.overlapRawPoints) {
      return { flushed: [], tail: this.displayTail() };
    }

    const keepCount = Math.max(2, this.config.overlapRawPoints);
    const keepIndex = Math.max(1, this.rawTail.length - keepCount);
    const boundaryTime = this.rawTail[keepIndex].timestamp;
    // 排出済み点列から境界を探す。値はプレビュー表示と同一オブジェクト由来のため、
    // 確定 prefix と表示 tail のつなぎ目に差分が生じない。
    let boundaryIndex = -1;
    for (let i = this.emitted.length - 1; i >= this.emittedFlushedCount; i--) {
      if (this.emitted[i].timestamp <= boundaryTime) { boundaryIndex = i; break; }
    }
    if (boundaryIndex < this.emittedFlushedCount) {
      return { flushed: [], tail: this.displayTail() };
    }

    const flushed = this.emitted.slice(this.emittedFlushedCount, boundaryIndex + 1);
    this.emittedFlushedCount = boundaryIndex + 1;
    this.rawTail = this.rawTail.slice(keepIndex);
    this.recalculateTailDistance();

    return { flushed, tail: this.displayTail() };
  }

  /**
   * 補間窓の再計算結果から未排出分だけを追加する。
   * 排出済み領域の再計算値（窓切り詰めによる微差）は捨てる。
   */
  private emitNew(processed: PointerPoint[]): void {
    for (const p of processed) {
      const last = this.emitted[this.emitted.length - 1];
      // 排出済み時刻より古い再計算値は捨てる。新規時刻は排出、
      // 同一時刻タイは novelty 判定（タイマー粒度潰れ対策）
      if (!last || p.timestamp > last.timestamp ||
        (p.timestamp === last.timestamp && this.movedSince(p, last))) {
        this.emitted.push({ ...p });
      }
    }
  }

  /** 同一時刻タイ（タイマー粒度潰れ）時のみ novelty 判定する */
  private movedSince(p: PointerPoint, last: PointerPoint): boolean {
    return Math.abs(p.x - last.x) > 1e-9 ||
      Math.abs(p.y - last.y) > 1e-9 ||
      Math.abs(p.pressure - last.pressure) > 1e-9 ||
      Math.abs(p.tiltX - last.tiltX) > 1e-9 ||
      Math.abs(p.tiltY - last.tiltY) > 1e-9;
  }

  /** 未確定の排出点列。同一参照を返すため再描画が冪等になる */
  private displayTail(): PointerPoint[] {
    return this.emitted.slice(this.emittedFlushedCount);
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
    this.emitted = [];
    this.emittedFlushedCount = 0;
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
