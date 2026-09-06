/**
 * Pulled String（紐引き）手ブレ補正
 *
 * ブラシとペン先を一定半径の「紐」で繋ぐモデル。
 * ペン先が半径内にいる間はブラシは動かず、紐が張ったときだけブラシが引かれる。
 * 微小な揺れは dead zone で吸収され、方向変化を残しやすいのが特徴。
 *
 * 仕様（docs/decisions/stabilization-pulled-string-post-correction-plan.md）:
 * - Phase 1 では決定的なバッチ変換として実装し、Catch Up（停止時追従）は行わない
 * - 紐が緩い間の出力はフィルタし、始点は必ず保持する
 * - finishLine でペンアップ時にブラシ→最終ペン位置まで描画間隔で再サンプリングする
 */

import type { PointerPoint } from './input.js';

/**
 * Pulled String 補正の設定
 */
export interface PulledStringConfig {
  /** 紐の長さ（px）。大きいほど強い補正。0 で補正なし */
  radius: number;
  /** ペンアップ時にブラシ位置から最終ペン位置まで線を引く */
  finishLine: boolean;
  /**
   * 速度適応: 速いほど実効半径を短くする（effR = radius / (1 + v/adaptiveSpeed)）。
   * ゆっくり書くときは steady、速く動かすときは軽い。false で古典動作。
   */
  adaptive: boolean;
  /** 実効半径が radius/2 になる筆速（px/sec） */
  adaptiveSpeed: number;
  /**
   * 反転緩み: ペンがブラシへ戻る方向（V·S < 0）に動いたら紐を slackFactor 倍に緩める。
   * 角の切り替えしでブラシが置いていかれる重さを軽減する。false で古典動作。
   */
  reverseSlack: boolean;
  /** 緩み係数（0..1）。小さいほど角で軽い */
  slackFactor: number;
}

const DEFAULT_CONFIG: PulledStringConfig = {
  radius: 8,
  finishLine: true,
  adaptive: true,
  adaptiveSpeed: 800,
  reverseSlack: true,
  slackFactor: 0.35,
};

/**
 * 描画間隔の目安。finishLine の再サンプリングに使用する。
 * Interpolator の spacing と同じ値を想定。
 */
const FINISH_LINE_SPACING_PX = 4;

/**
 * Pulled String 手ブレ補正クラス
 */
export class PulledStringStabilizer {
  private config: PulledStringConfig;
  private brushPos: PointerPoint | null = null;
  private penPos: PointerPoint | null = null;
  /** 平滑化した筆速（px/sec）。速度適応用 */
  private smoothSpeed = 0;
  private hasSpeed = false;
  private lastPen: { x: number; y: number; t: number } | null = null;

  constructor(config: Partial<PulledStringConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 単一の点を補正。
   * 紐が緩い間は null を返す（呼び出し側でフィルタする）。
   */
  stabilize(point: PointerPoint): PointerPoint | null {
    this.penPos = point;

    if (!this.brushPos) {
      // 始点はブラシ位置 = ペン位置
      this.brushPos = { ...point };
      this.lastPen = { x: point.x, y: point.y, t: point.timestamp };
      return { ...point };
    }

    const dx = point.x - this.brushPos.x;
    const dy = point.y - this.brushPos.y;
    const dist = Math.hypot(dx, dy);

    // 筆速を更新（指数平滑。初回は即時反映）
    const prevPen = this.lastPen;
    if (prevPen) {
      const mdx = point.x - prevPen.x, mdy = point.y - prevPen.y;
      const mlen = Math.hypot(mdx, mdy);
      const dt = point.timestamp - prevPen.t;
      if (dt > 0 && mlen > 1e-9) {
        const inst = (mlen / dt) * 1000;
        this.smoothSpeed = this.hasSpeed ? this.smoothSpeed + (inst - this.smoothSpeed) * 0.4 : inst;
        this.hasSpeed = true;
      }
    }
    this.lastPen = { x: point.x, y: point.y, t: point.timestamp };

    // 実効半径: 速度適応で短縮し、引き返し時はさらに緩める
    let effRadius = this.config.radius;
    if (this.config.adaptive) {
      effRadius = this.config.radius / (1 + this.smoothSpeed / Math.max(1, this.config.adaptiveSpeed));
    }
    if (this.config.reverseSlack && dist > 1e-9 && prevPen) {
      const mdx = point.x - prevPen.x, mdy = point.y - prevPen.y;
      const mlen = Math.hypot(mdx, mdy);
      // V·S < 0 ＝ペンがブラシへ戻る方向＝紐が緩む
      if (mlen > 1e-9 && (mdx * dx + mdy * dy) / (mlen * dist) < 0) {
        effRadius *= this.config.slackFactor;
      }
    }

    if (dist <= effRadius) {
      // 紐が緩い → ブラシは動かない
      return null;
    }

    // 紐が張った → ブラシをペン先方向に引っ張る
    // ブラシは常に実効半径分だけペン先より遅れる
    const t = (dist - effRadius) / dist;
    this.brushPos = {
      x: this.brushPos.x + dx * t,
      y: this.brushPos.y + dy * t,
      pressure: point.pressure,
      tiltX: point.tiltX,
      tiltY: point.tiltY,
      timestamp: point.timestamp,
    };
    return { ...this.brushPos };
  }

  /**
   * 複数の点を補正（バッチ処理）。
   * null をフィルタし、始点は必ず保持する。
   * finishAtLastInput=true のとき、最終ペン位置までの追従点を追加する。
   */
  stabilizeBatch(points: PointerPoint[], finishAtLastInput = false): PointerPoint[] {
    this.reset();
    if (points.length === 0) return [];

    const result: PointerPoint[] = [];
    for (const point of points) {
      const out = this.stabilize(point);
      if (out !== null) {
        result.push(out);
      }
    }

    // 始点がフィルタされるのを防ぐ（points[0] は stabilize 内で brushPos に設定されるので必ず出力される）
    // ただし radius=0 のときは全点が出力されるので問題なし

    if (finishAtLastInput && this.config.finishLine && points.length > 0) {
      const lastPen = points[points.length - 1];
      if (this.brushPos) {
        const finishPoints = this.resampleLine(this.brushPos, lastPen);
        // brushPos 自身は既に result に含まれている可能性があるので、
        // 2点目以降を追加
        for (let i = 1; i < finishPoints.length; i++) {
          result.push(finishPoints[i]);
        }
      } else {
        // brushPos がない（入力が1点だけ等）場合はそのまま
        result.push({ ...lastPen });
      }
    }

    return result;
  }

  /**
   * 2点間を指定間隔で再サンプリングする。
   * finishLine で長い1区間ができないよう、描画間隔に沿った中間点を生成する。
   */
  private resampleLine(from: PointerPoint, to: PointerPoint): PointerPoint[] {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return [{ ...to }];

    const spacing = FINISH_LINE_SPACING_PX;
    const numSteps = Math.max(1, Math.ceil(dist / spacing));
    const result: PointerPoint[] = [];
    for (let i = 0; i <= numSteps; i++) {
      const t = i / numSteps;
      result.push({
        x: from.x + dx * t,
        y: from.y + dy * t,
        pressure: from.pressure + (to.pressure - from.pressure) * t,
        tiltX: from.tiltX + (to.tiltX - from.tiltX) * t,
        tiltY: from.tiltY + (to.tiltY - from.tiltY) * t,
        timestamp: from.timestamp + (to.timestamp - from.timestamp) * t,
      });
    }
    return result;
  }

  /**
   * 内部状態をリセット
   */
  reset(): void {
    this.brushPos = null;
    this.penPos = null;
    this.smoothSpeed = 0;
    this.hasSpeed = false;
    this.lastPen = null;
  }

  /**
   * 現在の設定を取得
   */
  getConfig(): PulledStringConfig {
    return { ...this.config };
  }

  /**
   * 設定を更新
   */
  updateConfig(config: Partial<PulledStringConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
