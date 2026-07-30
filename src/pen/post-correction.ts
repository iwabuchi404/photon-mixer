/**
 * 後補正（Post-Correction / 事後補正）
 *
 * ペンアップ時にストローク全体を再平滑化する。
 * リアルタイム補正（EMA/Pulled String）の弱点（遅延・揺らぎ）を補完し、
 * 「描いた後に線がシュッと整う」挙動を実現する。
 *
 * アルゴリズム: 弧長リサンプリング + RDP間引き + centripetal Catmull-Rom再補間
 * - RDP で大きな形状変化を制御点として残し、直線上の中間点を削除
 * - 残った制御点を Catmull-Rom で再補間して滑らかな曲線を生成
 * - 始点・終点は必ず保持
 *
 * 仕様（docs/decisions/stabilization-pulled-string-post-correction-plan.md）:
 * - Phase 2 の対象は通常ブラシ・消しゴム・ぼかし。smudge は無効化
 * - PointerPoint[] の段階で処理し、finalizeStroke（筆圧→サイズ）より前
 * - 非再帰実装でスタックオーバーフローを防ぐ
 */

import type { PointerPoint } from './input.js';
import type { Interpolator } from './interpolation.js';

/**
 * 後補正の設定
 */
export interface PostCorrectionConfig {
  /** オン/オフ */
  enabled: boolean;
  /** RDP の許容誤差（px）。大きいほど強い平滑化 */
  tolerance: number;
}

const DEFAULT_CONFIG: PostCorrectionConfig = {
  enabled: false,
  tolerance: 2.0,
};

/**
 * 後補正クラス
 */
export class PostCorrector {
  private config: PostCorrectionConfig;
  private interpolator: Interpolator;

  constructor(interpolator: Interpolator, config: Partial<PostCorrectionConfig> = {}) {
    this.interpolator = interpolator;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * ストローク全体を後補正する。
   * 入力は PointerPoint[]（リアルタイム補正後、finalizeStroke 前）。
   *
   * Step 1: 弧長リサンプリングで入力間隔を均一化
   * Step 2: RDP で間引き（特徴点を残し、直線上の中間点を削除）
   * Step 3: Catmull-Rom で再補間
   */
  correct(points: PointerPoint[]): PointerPoint[] {
    if (!this.config.enabled || points.length < 3) return points;

    // Step 1: 弧長リサンプリング（既存 Interpolator のメソッドを再利用）
    const resampled = this.interpolator.resampleByArcLength(points);
    if (resampled.length < 3) return points;

    // Step 2: RDP で間引き
    const simplified = this.rdpSimplify(resampled, this.config.tolerance);
    if (simplified.length < 2) return points;

    // Step 3: Catmull-Rom で再補間（既存 Interpolator を再利用）
    const interpolated = this.interpolator.interpolate(simplified);

    // 始点・終点は元ストロークと一致させる（浮動小数誤差対策）
    if (interpolated.length > 0) {
      interpolated[0] = { ...points[0] };
      interpolated[interpolated.length - 1] = { ...points[points.length - 1] };
    }

    return interpolated;
  }

  /**
   * Ramer-Douglas-Peucker 法による点列の間引き。
   * 非再帰実装（スタック使用）でスタックオーバーフローを防ぐ。
   *
   * 始点・終点を結ぶ直線から最も離れた点を探し、許容誤差以内なら削除。
   * 許容誤差を超える点は残し、その点で区間を分割して再帰的に処理。
   */
  private rdpSimplify(points: PointerPoint[], tolerance: number): PointerPoint[] {
    if (points.length < 3) return points.map(p => ({ ...p }));

    const n = points.length;
    const keep = new Array<boolean>(n).fill(false);
    keep[0] = true;
    keep[n - 1] = true;

    // 非再帰実装: 処理すべき区間 [start, end] をスタックで管理
    const stack: Array<[number, number]> = [[0, n - 1]];

    while (stack.length > 0) {
      const [start, end] = stack.pop()!;
      if (end - start < 2) continue;

      // start と end を結ぶ直線から、区間内の各点の距離を計算
      let maxDist = 0;
      let maxIndex = start;
      const sx = points[start].x;
      const sy = points[start].y;
      const ex = points[end].x;
      const ey = points[end].y;
      const dx = ex - sx;
      const dy = ey - sy;
      const segLenSq = dx * dx + dy * dy;

      for (let i = start + 1; i < end; i++) {
        const dist = this.perpendicularDistance(points[i], sx, sy, ex, ey, segLenSq);
        if (dist > maxDist) {
          maxDist = dist;
          maxIndex = i;
        }
      }

      if (maxDist > tolerance) {
        // 最も離れた点を残し、両側の区間を処理対象に追加
        keep[maxIndex] = true;
        stack.push([start, maxIndex]);
        stack.push([maxIndex, end]);
      }
      // 許容誤差以内なら中間点は全て削除（keep のまま false）
    }

    // keep が true の点だけ残す
    const result: PointerPoint[] = [];
    for (let i = 0; i < n; i++) {
      if (keep[i]) result.push({ ...points[i] });
    }
    return result;
  }

  /**
   * 点から線分（start→end）への最短距離。
   * segLenSq は (end-start) の長さの2乗。0 の場合は start との距離。
   */
  private perpendicularDistance(
    point: PointerPoint,
    sx: number, sy: number,
    ex: number, ey: number,
    segLenSq: number,
  ): number {
    if (segLenSq < 1e-12) {
      // start と end が同一点 → start との距離
      return Math.hypot(point.x - sx, point.y - sy);
    }
    // 投影位置を線分内へクランプする。無限直線への距離にすると、
    // 折り返し形状で区間外の点を近すぎると判定して削除してしまう。
    const projection = ((point.x - sx) * (ex - sx) + (point.y - sy) * (ey - sy)) / segLenSq;
    const t = Math.max(0, Math.min(1, projection));
    const closestX = sx + (ex - sx) * t;
    const closestY = sy + (ey - sy) * t;
    return Math.hypot(point.x - closestX, point.y - closestY);
  }

  /**
   * 設定を取得
   */
  getConfig(): PostCorrectionConfig {
    return { ...this.config };
  }

  /**
   * 設定を更新
   */
  updateConfig(config: Partial<PostCorrectionConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
