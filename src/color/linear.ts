import type { LinearColor, SRGBColor } from './types.js';

// sRGB → リニア（読み込み時に1回）
export function srgbToLinear(v: number): number {
  return v <= 0.04045
    ? v / 12.92
    : Math.pow((v + 0.055) / 1.055, 2.4);
}

// リニア → sRGB（表示・エクスポート時）
export function linearToSrgb(v: number): number {
  const c = Math.max(0, Math.min(1, v)); // クランプ
  return c <= 0.0031308
    ? c * 12.92
    : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * リニア → 拡張 sRGB（上限をクランプしない）。
 * 1.0 超の HDR 値を単調に >1 へ符号化し、下側のみ 0 に丸める。
 * WGSL `composite.wgsl` の `linear_to_srgb_ext` と同一式。
 */
export function linearToSrgbExt(v: number): number {
  const c = Math.max(v, 0);
  return c <= 0.0031308
    ? c * 12.92
    : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** 拡張 sRGB → リニア（`linearToSrgbExt` の逆。1.0 超も受理する） */
export function srgbExtToLinear(v: number): number {
  return v <= 0.04045
    ? v / 12.92
    : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearColorToSrgb(c: LinearColor): SRGBColor {
  return {
    r: linearToSrgb(c.r),
    g: linearToSrgb(c.g),
    b: linearToSrgb(c.b),
    a: c.a,
  };
}

export function srgbColorToLinear(c: SRGBColor): LinearColor {
  return {
    r: srgbToLinear(c.r),
    g: srgbToLinear(c.g),
    b: srgbToLinear(c.b),
    a: c.a,
  };
}
