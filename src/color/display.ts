/**
 * 表示変換（ビュー露出 ＋ トーンマップ ＋ sRGB OETF）— 純粋関数。
 *
 * シーン リニア(HDR) → ×2^EV(露出) → トーンマップ([0,1]へ圧縮) → sRGB OETF。
 * GPU 側 `shaders/composite.wgsl` の fs_display と**同一式**で実装し、表示と PNG 書き出しを一致させる。
 * トーンマップ/モードの enum インデックスは WGSL・composite.ts と揃えること。
 */

import { linearToSrgb } from './linear.js';

export type TonemapId = 'pbrNeutral' | 'agx' | 'reinhard' | 'none';
/** WGSL の enum と一致させる（index = 値） */
export const TONEMAP_IDS: TonemapId[] = ['pbrNeutral', 'agx', 'reinhard', 'none'];

export type DisplayModeId = 'transform' | 'raw' | 'clip';
export const DISPLAY_MODE_IDS: DisplayModeId[] = ['transform', 'raw', 'clip'];

export type RGB = [number, number, number];

/** EV(ストップ) → 線形露出倍率 */
export function evToExposure(ev: number): number {
  return Math.pow(2, ev);
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// --- トーンマップ演算子（入力: 露出適用済みリニア / 出力: 表示リニア [0,1] 付近） ---

function reinhard(c: number): number {
  return c / (1 + c);
}

/** Khronos PBR Neutral（色に忠実・リニアsRGBで完結）。入出力ともリニア */
function pbrNeutral([r, g, b]: RGB): RGB {
  const startCompression = 0.8 - 0.04;
  const desaturation = 0.15;
  const x = Math.min(r, g, b);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= offset; g -= offset; b -= offset;
  const peak = Math.max(r, g, b);
  if (peak < startCompression) return [r, g, b];
  const d = 1 - startCompression;
  const newPeak = 1 - (d * d) / (peak + d - startCompression);
  const scale = newPeak / peak;
  r *= scale; g *= scale; b *= scale;
  const gFac = 1 - 1 / (desaturation * (peak - newPeak) + 1);
  return [
    r + (newPeak - r) * gFac,
    g + (newPeak - g) * gFac,
    b + (newPeak - b) * gFac,
  ];
}

// AgX（Rec.709 用行列内蔵・映画的）。Three.js 実装に準拠。入出力ともリニア
const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;
function agxContrast(x: number): number {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
function agx([r, g, b]: RGB): RGB {
  // inset 行列（列ベクトル定義を行展開）
  let ir = 0.856627153315983 * r + 0.0951212405381588 * g + 0.0482516061458583 * b;
  let ig = 0.137318972929847 * r + 0.761241990602591 * g + 0.101439036467562 * b;
  let ib = 0.11189821299995 * r + 0.0767994186031903 * g + 0.811302368396859 * b;
  const enc = (v: number) => {
    v = Math.max(v, 1e-10);
    v = Math.log2(v);
    v = (v - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
    return agxContrast(clamp01(v));
  };
  ir = enc(ir); ig = enc(ig); ib = enc(ib);
  // outset 行列
  let or_ = 1.1271005818144368 * ir - 0.11060664309660323 * ig - 0.016493938717834573 * ib;
  let og = -0.1413297634984383 * ir + 1.157823702216272 * ig - 0.016493938717834257 * ib;
  let ob = -0.14132976349843826 * ir - 0.11060664309660294 * ig + 1.2519364065950405 * ib;
  // 表示リニアへ（後段の sRGB OETF と合わせるため 2.2 で戻す）
  or_ = Math.pow(Math.max(0, or_), 2.2);
  og = Math.pow(Math.max(0, og), 2.2);
  ob = Math.pow(Math.max(0, ob), 2.2);
  return [clamp01(or_), clamp01(og), clamp01(ob)];
}

/** トーンマップ適用（露出適用済みリニア → 表示リニア [0,1]） */
export function tonemap(rgb: RGB, id: TonemapId): RGB {
  switch (id) {
    case 'pbrNeutral': return pbrNeutral(rgb);
    case 'agx': return agx(rgb);
    case 'reinhard': return [reinhard(rgb[0]), reinhard(rgb[1]), reinhard(rgb[2])];
    case 'none': return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
  }
}

/**
 * シーン リニア(straight, HDR) → 表示 sRGB(0..1)。
 * exposure = 2^EV、tonemap 指定。raw 相当が欲しい場合は id='none' を渡す。
 */
export function linearToDisplaySrgb(rgb: RGB, exposure: number, id: TonemapId): RGB {
  const exposed: RGB = [rgb[0] * exposure, rgb[1] * exposure, rgb[2] * exposure];
  const mapped = tonemap(exposed, id);
  return [linearToSrgb(mapped[0]), linearToSrgb(mapped[1]), linearToSrgb(mapped[2])];
}
