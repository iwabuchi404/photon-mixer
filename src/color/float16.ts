/**
 * float32 ⇄ float16（Uint16 表現）の相互変換。
 *
 * .pmx のタイル・スポイト readback・PNG 書き出しという
 * 「リニア HDR 値の入出力路」すべてがここを通るため、変換は単一実装に集約する
 * （HDR 値が経路ごとにずれると静かに壊れる）。
 */

/** float32 → float16（Uint16 表現） */
export function float32ToFloat16(f: number): number {
  const buf = new ArrayBuffer(4);
  const f32 = new Float32Array(buf);
  const u32 = new Uint32Array(buf);
  f32[0] = f;
  const x = u32[0];
  const s = (x >> 16) & 0x8000;
  const e = ((x >> 23) & 0xFF) - (127 - 15);
  const m = x & 0x7FFFFF;
  if (e <= 0) {
    if (e < -10) return s;
    return s | ((m | 0x800000) >> (1 - e) >> 13);
  }
  if (e >= 31) return s | 0x7C00; // ±Inf / NaN は飽和表現
  return s | (e << 10) | (m >> 13);
}

/** float16（Uint16 表現） → float32 */
export function float16ToFloat32(h: number): number {
  const sign = (h >> 15) & 1;
  const exp = (h >> 10) & 0x1F;
  const frac = h & 0x3FF;
  if (exp === 0) return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
  if (exp === 31) return frac === 0 ? (sign ? -Infinity : Infinity) : NaN;
  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}