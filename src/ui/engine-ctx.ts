/**
 * EngineCtx — UI から描画エンジンへ値を反映する唯一の窓口（facade）。
 *
 * 目的: パラメータの「反映ロジック」を1か所に集約し、イベントハンドラやツール切替の
 * 復元処理が共通の経路（このオブジェクト）だけを呼ぶようにする。
 * これにより反映の二重実装・取りこぼし・ツール間の状態混線といったバグを防ぐ。
 *
 * 注意: DOM には触れない（コントロールの値同期は呼び出し側 UI の責務）。
 */

import type { StrokeManager, PressureSizeConfig } from '../pen/stroke.js';
import type { StabilizationController, StabilizationMode } from '../pen/stabilization-mode.js';
import type { PostCorrector } from '../pen/post-correction.js';
import type { Interpolator } from '../pen/interpolation.js';
import type { RenderPipeline } from '../render/pipeline.js';
import type { BrushMixMode } from '../render/brush.js';
import type { LinearColor } from '../color/types.js';

export type PressureCurve = PressureSizeConfig['curve'];

/** EngineCtx が参照する共有状態（main の AppState の一部） */
export interface SharedState {
  currentColor: LinearColor;
  wetRatio: number;
  mixMode: BrushMixMode;
  textureScale: number;
  bucketTolerance: number;
  useTexture: boolean;
  pressureOpacity: boolean;
  /** スタンプ間隔（直径比 0..1）。テクスチャブラシ用 */
  spacingRatio: number;
}

export interface EngineDeps {
  strokeManager: StrokeManager;
  stabilizer: StabilizationController;
  postCorrector: PostCorrector;
  interpolator: Interpolator;
  getPipeline: () => RenderPipeline | null;
  getIsRibbonTool: () => boolean;
  state: SharedState;
}

/** パラメータごとの反映メソッド。値域は呼び出し側で正規化済みを前提とする */
export interface EngineCtx {
  /** ブラシ径(px)。base は max の約10% */
  setSize(px: number): void;
  /** 不透明度 0..1（描画色のα。色自体は共有） */
  setOpacity(a01: number): void;
  /** 筆圧を不透明度へ反映する */
  setPressureOpacity(enabled: boolean): void;
  /** にじみ 0..1 */
  setWet(w01: number): void;
  /** 手ブレ補正 0..100(%)。0=補正なし, 100=最も滑らか */
  setStabilize(pct: number): void;
  /** 手ブレ補正方式（EMA / Pulled String） */
  setStabilizeMode(mode: StabilizationMode): void;
  /** 後補正のオン/オフ */
  setPostCorrection(enabled: boolean): void;
  /** 後補正強度 0..100(%) */
  setPostCorrectionStrength(pct: number): void;
  /** 混色方式 */
  setMixMode(mode: BrushMixMode): void;
  /** 筆圧カーブ */
  setPressureCurve(curve: PressureCurve): void;
  /** テクスチャ繰り返しスケール */
  setTextureScale(x: number): void;
  /** 塗り/自動選択の許容値 0..1 */
  setTolerance(t01: number): void;
  /** スタンプ間隔（直径比 0..1）。テクスチャブラシ用。リボン筆では無視 */
  setSpacing(r01: number): void;
}

export function createEngineCtx(deps: EngineDeps): EngineCtx {
  const { strokeManager, stabilizer, postCorrector, interpolator, getPipeline, getIsRibbonTool, state } = deps;
  // 補間点間隔を現在のツール・筆径・間隔比から決める。
  // リボン筆は間隔概念を持たないため常に密（1px）。テクスチャブラシは直径比。
  const refreshSpacing = () => {
    if (getIsRibbonTool()) {
      interpolator.updateConfig({ spacing: 1 });
    } else {
      const maxSize = strokeManager.getPressureConfig().maxSize;
      interpolator.updateConfig({ spacing: Math.max(1, Math.round(maxSize * state.spacingRatio)) });
    }
  };
  return {
    setSize(px) {
      const maxSize = Math.max(1, Math.min(100, Math.round(px)));
      const baseSize = Math.max(1, Math.round(maxSize * 0.1));
      strokeManager.updatePressureConfig({ maxSize, baseSize });
      refreshSpacing();
    },
    setOpacity(a01) {
      state.currentColor.a = a01;
      getPipeline()?.updateBrushConfig({ color: { ...state.currentColor } });
    },
    setPressureOpacity(enabled) {
      state.pressureOpacity = enabled;
      getPipeline()?.updateBrushConfig({ pressureOpacity: enabled });
    },
    setWet(w01) {
      state.wetRatio = w01;
      getPipeline()?.updateBrushConfig({ wetRatio: w01 });
    },
    setStabilize(pct) {
      // EMA: 0% → minAlpha=1.0（補正オフ）, 100% → minAlpha=0.1（強い補正）
      const minAlpha = 1.0 - (pct / 100) * 0.9;
      stabilizer.updateEmaConfig({ minAlpha });
      // Pulled String: 0% → radius=0px（補正オフ）, 100% → radius=50px（強い補正）
      const radius = (pct / 100) * 50;
      stabilizer.updatePulledStringConfig({ radius });
    },
    setStabilizeMode(mode) {
      stabilizer.setMode(mode);
    },
    setPostCorrection(enabled) {
      postCorrector.updateConfig({ enabled });
    },
    setPostCorrectionStrength(pct) {
      // 0% = tolerance=0.5px（弱）, 100% = tolerance=10px（強）
      const tolerance = 0.5 + (pct / 100) * 9.5;
      postCorrector.updateConfig({ tolerance });
    },
    setMixMode(mode) {
      state.mixMode = mode;
      getPipeline()?.updateBrushConfig({ mixMode: mode });
    },
    setPressureCurve(curve) {
      strokeManager.updatePressureConfig({ curve });
    },
    setTextureScale(x) {
      state.textureScale = x;
      getPipeline()?.updateBrushConfig({ textureScale: x });
    },
    setTolerance(t01) {
      state.bucketTolerance = t01;
    },
    setSpacing(r01) {
      state.spacingRatio = Math.max(0.05, Math.min(0.5, r01));
      refreshSpacing();
    },
  };
}
