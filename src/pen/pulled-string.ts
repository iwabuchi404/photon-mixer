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

/** 速度・方向推定の時間窓（ms）。1サンプルのノイズで反転判定しないため */
const WINDOW_MS = 16;
/** 窓の最小距離 = 実効半径のこの割合。時間窓が短くても最低限の距離を確保する */
const WINDOW_MIN_FRAC = 0.5;
/** 履歴の上限（メモリ・走査コストの上限） */
const MAX_HISTORY = 64;
/** 筆圧平滑化の基準α（120Hz 基準、時間補正あり） */
const PRESSURE_ALPHA = 0.35;
const NOMINAL_INTERVAL_MS = 1000 / 120;

/**
 * Pulled String 手ブレ補正クラス
 */
export class PulledStringStabilizer {
  private config: PulledStringConfig;
  private brushPos: PointerPoint | null = null;
  private penPos: PointerPoint | null = null;
  /** 直近の生ペン位置履歴（速度・方向の窓推定用） */
  private penHistory: { x: number; y: number; t: number }[] = [];
  /** 引き返し（紐の緩み）状態。窓推定で一度入ったら正向きまで維持するヒステリシス */
  private slacked = false;
  /** 平滑化した筆圧。ブラシ位置はペンより遅れるため、生筆圧をそのまま使わない */
  private smoothPressure: number | null = null;
  private lastT: number | null = null;
  /** 表示スケール（画面px/キャンバスpx）。radius は画面上の見た目 px として扱う */
  private viewScale = 1;

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
      this.penHistory = [{ x: point.x, y: point.y, t: point.timestamp }];
      this.smoothPressure = point.pressure;
      this.lastT = point.timestamp;
      return { ...point };
    }

    const dx = point.x - this.brushPos.x;
    const dy = point.y - this.brushPos.y;
    const dist = Math.hypot(dx, dy);

    // 時間窓（〜16ms）+ 距離窓（実効半径の半分）で速度・方向を推定する。
    // 240Hz の 1 サンプル移動はサブピクセルでノイズまみれなので、
    // 単発サンプルでの V·S 判定・速度計算を避ける。
    this.penHistory.push({ x: point.x, y: point.y, t: point.timestamp });
    if (this.penHistory.length > MAX_HISTORY) this.penHistory.shift();
    const win = this.windowBack(this.config.radius / Math.max(0.01, this.viewScale) * WINDOW_MIN_FRAC);
    const vel = win.speed;

    // 筆圧の平滑化（モード共通。筆圧ノイズが太さの階段になるのを防ぐ）
    const dt = this.lastT === null ? 0 : Math.max(0, point.timestamp - this.lastT);
    const pAlpha = this.timeAdjustedAlpha(PRESSURE_ALPHA, dt);
    this.smoothPressure = this.smoothPressure === null
      ? point.pressure
      : this.smoothPressure + (point.pressure - this.smoothPressure) * pAlpha;
    this.lastT = point.timestamp;

    // 実効半径: 速度適応で短縮し、引き返し時はさらに緩める。
    // radius・adaptiveSpeed は画面上の見た目基準なのでキャンバス単位へ換算する。
    const s = Math.max(0.01, this.viewScale);
    const radiusC = this.config.radius / s;
    const adaptiveSpeedC = Math.max(1, this.config.adaptiveSpeed / s);
    let effRadius = radiusC;
    if (this.config.adaptive) {
      effRadius = radiusC / (1 + vel / adaptiveSpeedC);
    }
    if (this.config.reverseSlack && dist > 1e-9 && win.len > 1e-9) {
      // V·S < 0 ＝ペンがブラシへ戻る方向＝紐が緩む。
      // 窓ベクトルで判定し、一度緩んだら正向きになるまで維持（ヒステリシス）
      const dot = (win.dx * dx + win.dy * dy) / (win.len * dist);
      if (dot < -0.05) this.slacked = true;
      else if (dot > 0.05) this.slacked = false;
      if (this.slacked) effRadius *= this.config.slackFactor;
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
      pressure: this.smoothPressure ?? point.pressure,
      tiltX: point.tiltX,
      tiltY: point.tiltY,
      timestamp: point.timestamp,
    };
    return { ...this.brushPos };
  }

  /**
   * 履歴末尾から時間窓（WINDOW_MS）+ 距離窓（minDist）を満たす起点を探し、
   * その区間の変位ベクトルと速度（px/sec）を返す。
   */
  private windowBack(minDist: number): { dx: number; dy: number; len: number; speed: number } {
    const h = this.penHistory;
    const cur = h[h.length - 1];
    // 時間窓内の最古サンプル
    let i = h.length - 1;
    while (i > 0 && cur.t - h[i - 1].t <= WINDOW_MS) i--;
    // 距離が足りなければ履歴をさかのぼって延長する
    while (i > 0 && Math.hypot(cur.x - h[i].x, cur.y - h[i].y) < minDist) i--;
    const base = h[i];
    const dx = cur.x - base.x;
    const dy = cur.y - base.y;
    const len = Math.hypot(dx, dy);
    const dt = cur.t - base.t;
    const speed = dt > 0.5 && len > 1e-9 ? (len / dt) * 1000 : 0;
    return { dx, dy, len, speed };
  }

  private timeAdjustedAlpha(baseAlpha: number, dtMs: number): number {
    if (baseAlpha >= 1) return 1;
    if (dtMs <= 0) return 0;
    return 1 - Math.pow(1 - baseAlpha, dtMs / NOMINAL_INTERVAL_MS);
  }

  /** 表示スケールを設定（ズーム連動補正。A3） */
  setViewScale(scale: number): void {
    this.viewScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
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
    this.penHistory = [];
    this.slacked = false;
    this.smoothPressure = null;
    this.lastT = null;
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
