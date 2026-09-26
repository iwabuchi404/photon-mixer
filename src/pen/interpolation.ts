/**
 * 弧長リサンプリング + centripetal Catmull-Rom 補間
 *
 * 入力イベントの密度に依存せず、太い線でも曲率が不均一になりにくい
 * 中心軌跡を生成する。
 */

import type { PointerPoint } from './input.js';

export interface InterpolationConfig {
  /** 最終的な描画点の目標間隔（px） */
  spacing: number;
  /**
   * 弧長リサンプリングの間隔（px）。
   * interpolate() では生点をそのまま制御点に使うため使われない。
   * PostCorrector の事前間引き（resampleByArcLength の既定値）として残す。
   */
  inputSpacing: number;
  /** 高速先端予測を行う速度閾値（px/sec） */
  speedThreshold: number;
}

const DEFAULT_CONFIG: InterpolationConfig = {
  spacing: 4,
  inputSpacing: 2,
  speedThreshold: 2000,
};

/** 補間へ通す前に間引く最小間隔（px）。240Hz 入力の静止重複点を除去する */
const THIN_PX = 0.5;

export class Interpolator {
  private config: InterpolationConfig;

  constructor(config: Partial<InterpolationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 生点列へ centripetal Catmull-Rom を直接掛け、弧長 spacing で排出する。
   *
   * 事前の折れ線リサンプル（resampleByArcLength）は行わない。
   * 折れ線上に載った制御点を補間すると結果が事実上の区分線形になり、
   * 曲線の滑らかさが失われるため。centripetal パラメータ化は
   * 不均一な点間隔をそのまま扱える。
   *
   * predict=true は将来の「末尾1区間だけ仮描画」用。現在のライブ描画では
   * ストローク全体を再描画するため、呼び出し側はfalseのまま使用する。
   */
  interpolate(points: PointerPoint[], predict = false): PointerPoint[] {
    if (points.length < 2) return points.map(p => ({ ...p }));

    // 密な生点（ほぼ同一位置の重複サンプル）を間引く
    const source = this.thinPoints(points, THIN_PX);
    if (predict && source.length >= 2) {
      const last = source[source.length - 1];
      const prev = source[source.length - 2];
      if (this.calculateVelocity(prev, last) > this.config.speedThreshold) {
        const predicted = this.predictNextPoint(source);
        if (predicted) source.push(predicted);
      }
    }
    if (source.length < 2) return source;

    const result: PointerPoint[] = [{ ...source[0] }];
    let carry = 0; // 前回排出点からの弧長の積算
    for (let i = 0; i < source.length - 1; i++) {
      const p1 = source[i];
      const p2 = source[i + 1];
      const p0 = i > 0
        ? source[i - 1]
        : this.extrapolateEndpoint(p1, p2);
      const p3 = i + 2 < source.length
        ? source[i + 2]
        : this.extrapolateEndpoint(p2, p1);
      carry = this.emitSegmentByArcLength(p0, p1, p2, p3, result, carry);
    }

    // 浮動小数誤差が累積しても、確定ストロークの終端は入力終端と一致させる。
    const end = source[source.length - 1];
    const lastOut = result[result.length - 1];
    if (Math.hypot(end.x - lastOut.x, end.y - lastOut.y) <= Math.max(this.config.spacing, 1e-3)) {
      result[result.length - 1] = { ...end };
    } else {
      result.push({ ...end });
    }
    return result;
  }

  /**
   * 1区間の centripetal Catmull-Rom 曲線を密にサンプルして弧長を測り、
   * spacing 間隔ごとに排出点を打つ。区間をまたぐ余り距離は carry で持ち越し、
   * ストローク全体で均一な弧長間隔になる。
   * 戻り値は次区間へ持ち越す余り距離。
   */
  private emitSegmentByArcLength(
    p0: PointerPoint,
    p1: PointerPoint,
    p2: PointerPoint,
    p3: PointerPoint,
    out: PointerPoint[],
    carry: number,
  ): number {
    const t0 = 0;
    const t1 = t0 + this.knotInterval(p0, p1);
    const t2 = t1 + this.knotInterval(p1, p2);
    const t3 = t2 + this.knotInterval(p2, p3);
    const spacing = Math.max(this.config.spacing, 0.01);

    const posAt = (u: number) =>
      this.centripetalPosition(p0, p1, p2, p3, t0, t1, t2, t3, t1 + (t2 - t1) * u);

    // 粗く弧長を見積もって密サンプル数を決める（排出点あたり4点以上）
    const COARSE = 8;
    let prev = posAt(0);
    let arcLen = 0;
    for (let j = 1; j <= COARSE; j++) {
      const pos = posAt(j / COARSE);
      arcLen += Math.hypot(pos.x - prev.x, pos.y - prev.y);
      prev = pos;
    }
    if (arcLen <= 1e-9) return carry;

    const fine = Math.min(256, Math.max(8, Math.ceil((arcLen / spacing) * 4)));
    let dist = carry;
    prev = posAt(0);
    for (let j = 1; j <= fine; j++) {
      const u = j / fine;
      const pos = posAt(u);
      let segD = Math.hypot(pos.x - prev.x, pos.y - prev.y);
      let ax = prev.x;
      let ay = prev.y;
      let u0 = (j - 1) / fine;
      while (segD > 1e-9 && dist + segD >= spacing) {
        const need = spacing - dist;
        const frac = need / segD;
        const ex = ax + (pos.x - ax) * frac;
        const ey = ay + (pos.y - ay) * frac;
        const uEff = u0 + frac * (u - u0);
        out.push({
          x: ex,
          y: ey,
          pressure: this.lerp(p1.pressure, p2.pressure, uEff),
          tiltX: this.lerp(p1.tiltX, p2.tiltX, uEff),
          tiltY: this.lerp(p1.tiltY, p2.tiltY, uEff),
          timestamp: this.lerp(p1.timestamp, p2.timestamp, uEff),
        });
        ax = ex;
        ay = ey;
        u0 = uEff;
        segD -= need;
        dist = 0;
      }
      dist += segD;
      prev = pos;
    }
    return dist;
  }

  /**
   * ほぼ同一位置の連続点を間引く。最後の生点は位置・属性を正確に保つ
   * （離筆時の筆圧・時刻が終端処理で使われるため）。
   */
  private thinPoints(points: PointerPoint[], minDist: number): PointerPoint[] {
    const result: PointerPoint[] = [{ ...points[0] }];
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      const last = result[result.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < minDist) {
        if (i === points.length - 1) result[result.length - 1] = { ...p };
        continue;
      }
      result.push({ ...p });
    }
    return result;
  }

  /**
   * 入力点を一定距離間隔へ並べ直す。区間をまたぐ余り距離を保持するため、
   * 元イベントの間隔が不均一でも出力密度は均一になる。
   */
  resampleByArcLength(points: PointerPoint[], spacing = this.config.inputSpacing): PointerPoint[] {
    if (points.length < 2 || spacing <= 0) return points.map(p => ({ ...p }));

    const result: PointerPoint[] = [{ ...points[0] }];
    let previous = { ...points[0] };
    let distanceToNext = spacing;

    for (let i = 1; i < points.length; i++) {
      const target = points[i];
      let dx = target.x - previous.x;
      let dy = target.y - previous.y;
      let segmentLength = Math.hypot(dx, dy);

      // 同一点は位置の制御点として追加せず、終端属性だけ最後に保持する。
      if (segmentLength <= 1e-6) {
        previous = { ...target };
        continue;
      }

      while (segmentLength + 1e-9 >= distanceToNext) {
        const t = distanceToNext / segmentLength;
        const sample = this.lerpPoint(previous, target, t);
        result.push(sample);
        previous = sample;
        dx = target.x - previous.x;
        dy = target.y - previous.y;
        segmentLength = Math.hypot(dx, dy);
        distanceToNext = spacing;
      }

      distanceToNext -= segmentLength;
      previous = { ...target };
    }

    const end = points[points.length - 1];
    const last = result[result.length - 1];
    if (Math.hypot(end.x - last.x, end.y - last.y) > 1e-6) {
      result.push({ ...end });
    } else {
      result[result.length - 1] = { ...end };
    }
    return result;
  }

  /**
   * Barry-Goldman形式のcentripetal Catmull-Rom。
   * knot interval = distance^0.5（alpha=0.5）。
   */
  private centripetalPosition(
    p0: PointerPoint,
    p1: PointerPoint,
    p2: PointerPoint,
    p3: PointerPoint,
    t0: number,
    t1: number,
    t2: number,
    t3: number,
    t: number,
  ): { x: number; y: number } {
    const a1 = this.mixPosition(p0, p1, this.ratio(t0, t1, t));
    const a2 = this.mixPosition(p1, p2, this.ratio(t1, t2, t));
    const a3 = this.mixPosition(p2, p3, this.ratio(t2, t3, t));
    const b1 = this.mixPosition(a1, a2, this.ratio(t0, t2, t));
    const b2 = this.mixPosition(a2, a3, this.ratio(t1, t3, t));
    return this.mixPosition(b1, b2, this.ratio(t1, t2, t));
  }

  private knotInterval(a: PointerPoint, b: PointerPoint): number {
    // 完全な重複点でも分母を0にしない。
    return Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
  }

  private ratio(start: number, end: number, value: number): number {
    const width = end - start;
    return width > 1e-9 ? (value - start) / width : 0;
  }

  private mixPosition(
    a: { x: number; y: number },
    b: { x: number; y: number },
    t: number,
  ): { x: number; y: number } {
    return { x: this.lerp(a.x, b.x, t), y: this.lerp(a.y, b.y, t) };
  }

  private extrapolateEndpoint(anchor: PointerPoint, neighbor: PointerPoint): PointerPoint {
    return {
      x: anchor.x + (anchor.x - neighbor.x),
      y: anchor.y + (anchor.y - neighbor.y),
      pressure: anchor.pressure,
      tiltX: anchor.tiltX,
      tiltY: anchor.tiltY,
      timestamp: anchor.timestamp - (neighbor.timestamp - anchor.timestamp),
    };
  }

  private predictNextPoint(points: PointerPoint[]): PointerPoint | null {
    if (points.length < 2) return null;
    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    const dt = Math.max(1, last.timestamp - prev.timestamp);
    const vx = (last.x - prev.x) / dt;
    const vy = (last.y - prev.y) / dt;

    let ax = 0;
    let ay = 0;
    if (points.length >= 3) {
      const prev2 = points[points.length - 3];
      const dt0 = Math.max(1, prev.timestamp - prev2.timestamp);
      ax = (vx - (prev.x - prev2.x) / dt0) / dt;
      ay = (vy - (prev.y - prev2.y) / dt0) / dt;
    }

    return {
      x: last.x + vx * dt + 0.5 * ax * dt * dt,
      y: last.y + vy * dt + 0.5 * ay * dt * dt,
      pressure: last.pressure,
      tiltX: last.tiltX,
      tiltY: last.tiltY,
      timestamp: last.timestamp + dt,
    };
  }

  private lerpPoint(a: PointerPoint, b: PointerPoint, t: number): PointerPoint {
    return {
      x: this.lerp(a.x, b.x, t),
      y: this.lerp(a.y, b.y, t),
      pressure: this.lerp(a.pressure, b.pressure, t),
      tiltX: this.lerp(a.tiltX, b.tiltX, t),
      tiltY: this.lerp(a.tiltY, b.tiltY, t),
      timestamp: this.lerp(a.timestamp, b.timestamp, t),
    };
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private calculateVelocity(from: PointerPoint, to: PointerPoint): number {
    const dt = to.timestamp - from.timestamp;
    if (dt <= 0) return 0;
    return (Math.hypot(to.x - from.x, to.y - from.y) / dt) * 1000;
  }

  getConfig(): InterpolationConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<InterpolationConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
