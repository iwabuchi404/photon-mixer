/**
 * 手ブレ補正方式の切り替え制御
 *
 * EMA（指数移動平均）と Pulled String（紐引き）の2方式を統合し、
 * UI から方式を切り替えられるようにする。
 * 下流のインターフェース（stabilizeBatch）は Stabilizer と互換。
 *
 * 仕様（docs/decisions/stabilization-pulled-string-post-correction-plan.md）:
 * - リアルタイム補正は EMA / Pulled String の排他選択
 * - StabilizationController は Stabilizer とインターフェース互換
 */

import type { PointerPoint } from './input.js';
import { Stabilizer, type StabilizationConfig } from './stabilization.js';
import { PulledStringStabilizer, type PulledStringConfig } from './pulled-string.js';

export type StabilizationMode = 'ema' | 'pulled-string';

/**
 * 手ブレ補正の統合設定
 */
export interface StabilizationSettings {
  mode: StabilizationMode;
  emaConfig: Partial<StabilizationConfig>;
  pulledStringConfig: Partial<PulledStringConfig>;
}

/**
 * 手ブレ補正の統合コントローラー
 * mode に応じて内部で EMA / Pulled String を切り替える。
 * Stabilizer と同じ stabilizeBatch インターフェースを提供する。
 */
export class StabilizationController {
  private ema: Stabilizer;
  private pulledString: PulledStringStabilizer;
  private mode: StabilizationMode = 'pulled-string';

  constructor(settings: Partial<StabilizationSettings> = {}) {
    this.ema = new Stabilizer(settings.emaConfig);
    this.pulledString = new PulledStringStabilizer(settings.pulledStringConfig);
    if (settings.mode) this.mode = settings.mode;
  }

  /**
   * 複数の点を補正（バッチ処理）。
   * 現在の mode に応じて内部インスタンスを切り替える。
   * Stabilizer.stabilizeBatch と同じシグネチャ。
   */
  stabilizeBatch(points: PointerPoint[], finishAtLastInput = false): PointerPoint[] {
    if (this.mode === 'pulled-string') {
      return this.pulledString.stabilizeBatch(points, finishAtLastInput);
    }
    return this.ema.stabilizeBatch(points, finishAtLastInput);
  }

  /**
   * ライブ入力を増分処理する。Pulled String の dead zone 中は null を返す。
   */
  stabilize(point: PointerPoint): PointerPoint | null {
    if (this.mode === 'pulled-string') return this.pulledString.stabilize(point);
    return this.ema.stabilize(point);
  }

  /**
   * 補正方式を切り替える
   */
  setMode(mode: StabilizationMode): void {
    this.mode = mode;
  }

  /**
   * 現在の補正方式を取得
   */
  getMode(): StabilizationMode {
    return this.mode;
  }

  /**
   * EMA の設定を更新
   */
  updateEmaConfig(config: Partial<StabilizationConfig>): void {
    this.ema.updateConfig(config);
  }

  /**
   * Pulled String の設定を更新
   */
  updatePulledStringConfig(config: Partial<PulledStringConfig>): void {
    this.pulledString.updateConfig(config);
  }

  /**
   * EMA インスタンスを取得（デバッグ・テスト用）
   */
  getEmaStabilizer(): Stabilizer {
    return this.ema;
  }

  /**
   * Pulled String インスタンスを取得（デバッグ・テスト用）
   */
  getPulledStringStabilizer(): PulledStringStabilizer {
    return this.pulledString;
  }

  /**
   * 内部状態をリセット
   */
  reset(): void {
    this.ema.reset();
    this.pulledString.reset();
  }
}
