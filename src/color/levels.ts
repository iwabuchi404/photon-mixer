/**
 * レベル補正（Levels）の純粋関数。
 * sRGB 域の値 v(0..1) に対し: 入力黒/白で正規化 → ガンマ → 出力黒/白へマッピング。
 * GPU 側 filter.wgsl の levels1 と同一式（パリティをテストで担保）。
 */

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
