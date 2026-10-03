/**
 * レベル補正（Levels）の純粋関数。
 * sRGB 域の値 v(0..1) に対し: 入力黒/白で正規化 → ガンマ → 出力黒/白へマッピング。
 * GPU 側 filter.wgsl の levels1 と同一式（パリティをテストで担保）。
 */

import { linearToSrgbExt, srgbExtToLinear } from './linear.js';

export interface LevelsParams {
  inLow: number;   // 入力黒点 (0..1)
  inHigh: number;  // 入力白点 (0..1)
  gamma: number;   // 中間調ガンマ（1=変化なし, >1で明るく）
  outLow: number;  // 出力黒点 (0..1)
  outHigh: number; // 出力白点 (0..1)
}

export function applyLevels(v: number, p: LevelsParams): number {
  let n = (v - p.inLow) / Math.max(p.inHigh - p.inLow, 1e-4);
  n = Math.max(0, Math.min(1, n));
  n = Math.pow(n, 1 / Math.max(p.gamma, 1e-4));
  return p.outLow + n * (p.outHigh - p.outLow);
}

/**
 * リニア HDR 入力（1.0 超可）に対する Levels。GPU 側 `fs_levels` と同一式。
 *
 * 補正自体は 0..1 の符号化域で行うため SDR の挙動は applyLevels と同一だが、
 * 1.0 を超える分（ext - 1）を補正の局所ゲインで引き伸ばすので、
 * Glow/露出で生じた HDR 光量を潰さない。identity パラメータでは厳密に恒等。
 */
export function applyLevelsLinear(linearV: number, p: LevelsParams): number {
  const ext = linearToSrgbExt(linearV);
  const sIn = Math.max(0, Math.min(1, ext));
  const sOut = applyLevels(sIn, p);
  const gain = sIn < 1e-4 ? 1 : sOut / sIn;
  return srgbExtToLinear(sOut + Math.max(ext - 1, 0) * gain);
}
