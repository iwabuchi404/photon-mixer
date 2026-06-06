/**
 * トーンカーブ評価（単調キュービック / Fritsch–Carlson）。
 * 制御点（[0,1]×[0,1], x昇順, 端点は x=0 と x=1）から 256 エントリの LUT を生成する。
 * sRGB 域の入力値に対する出力を返す（filter.wgsl の fs_curve が LUT を参照）。
 */

export interface CurvePoint { x: number; y: number }

/** 制御点列を 256 サンプルに評価（各 0..1、単調性を保つ） */
export function sampleCurve(points: CurvePoint[]): number[] {
  const pts = [...points].sort((a, b) => a.x - b.x);
  const n = pts.length;
  if (n < 2) return Array.from({ length: 256 }, (_, k) => k / 255);

  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  const dx: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = Math.max(xs[i + 1] - xs[i], 1e-6);
    m[i] = (ys[i + 1] - ys[i]) / dx[i];
  }
  // 接線
  const t = new Array<number>(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    t[i] = (m[i - 1] * m[i] <= 0) ? 0 : (m[i - 1] + m[i]) / 2;
  }
  // Fritsch–Carlson 単調性補正
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      t[i] = tau * a * m[i];
      t[i + 1] = tau * b * m[i];
    }
  }

  const out: number[] = new Array(256);
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = dx[i];
    const tt = Math.max(0, Math.min(1, (x - xs[i]) / h));
    const tt2 = tt * tt, tt3 = tt2 * tt;
    const h00 = 2 * tt3 - 3 * tt2 + 1;
    const h10 = tt3 - 2 * tt2 + tt;
    const h01 = -2 * tt3 + 3 * tt2;
    const h11 = tt3 - tt2;
    const y = h00 * ys[i] + h10 * h * t[i] + h01 * ys[i + 1] + h11 * h * t[i + 1];
    out[k] = Math.max(0, Math.min(1, y));
  }
  return out;
}

/** 制御点列から GPU LUT（256×1, rgba8unorm 相当のバイト列）を生成 */
export function buildCurveLut(points: CurvePoint[]): Uint8Array {
  const samples = sampleCurve(points);
  const data = new Uint8Array(256 * 4);
  for (let k = 0; k < 256; k++) {
    const b = Math.round(samples[k] * 255);
    data[k * 4] = b; data[k * 4 + 1] = b; data[k * 4 + 2] = b; data[k * 4 + 3] = 255;
  }
  return data;
}
