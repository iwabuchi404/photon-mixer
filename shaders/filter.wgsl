/**
 * フィルター処理シェーダー（オフスクリーン・フルスクリーンパス）
 * 入力はリニア・プリマルチプライドα（committed と同形式）。
 *
 * エントリ:
 *  fs_blur          — 分離可能ガウシアン（dir で水平/垂直）
 *  fs_threshold     — しきい値抽出（Glow 用。>threshold の光を取り出す）
 *  fs_add_glow      — 元画像 + グロー×intensity（HDR 加算）
 *  fs_mask_composite— filtered と original を選択マスクで合成
 */

struct FilterU {
  texel: vec2f,     // 1/width, 1/height
  dir: vec2f,       // ぼかし方向 (1,0) or (0,1)
  radius: f32,      // ぼかし半径(px)
  threshold: f32,   // グロー抽出しきい値
  intensity: f32,   // グロー/シャープ強度
  use_mask: f32,    // 1=選択マスク適用
  ev: f32,          // 露出調整(ストップ)
  in_low: f32,      // レベル: 入力黒
  in_high: f32,     // レベル: 入力白
  gamma: f32,       // レベル: ガンマ
  out_low: f32,     // レベル: 出力黒
  out_high: f32,    // レベル: 出力白
  _p0: f32,
  _p1: f32,
}

@group(0) @binding(0) var tex0: texture_2d<f32>; // 主入力
@group(0) @binding(1) var tex1: texture_2d<f32>; // 副入力（original / glow）
@group(0) @binding(2) var tex2: texture_2d<f32>; // マスク
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> u: FilterU;

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_fullscreen(@builtin(vertex_index) vid: u32) -> VOut {
  var pos = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  var uv = array<vec2f, 4>(vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 0.0));
  var o: VOut;
  o.position = vec4f(pos[vid], 0.0, 1.0);
  o.uv = uv[vid];
  return o;
}

const MAX_TAPS: i32 = 64;

// 分離可能ガウシアン（プリマルチプライドのまま全chをぼかす）
@fragment
fn fs_blur(in: VOut) -> @location(0) vec4f {
  let radius = max(u.radius, 0.0);
  let sigma = max(radius / 3.0, 0.0001);
  let inv2s2 = 1.0 / (2.0 * sigma * sigma);
  var sum = vec4f(0.0);
  var wsum = 0.0;
  var i = -MAX_TAPS;
  loop {
    if (i > MAX_TAPS) { break; }
    let fi = f32(i);
    if (abs(fi) <= radius) {
      let w = exp(-fi * fi * inv2s2);
      let uv = in.uv + u.dir * u.texel * fi;
      sum += textureSampleLevel(tex0, samp, uv, 0.0) * w;
      wsum += w;
    }
    i = i + 1;
  }
  return sum / max(wsum, 0.0001);
}

// グロー抽出: しきい値を超えた分の光を取り出す（プリマルチプライド rgb ベース）
@fragment
fn fs_threshold(in: VOut) -> @location(0) vec4f {
  let c = textureSampleLevel(tex0, samp, in.uv, 0.0);
  let e = max(c.rgb - vec3f(u.threshold), vec3f(0.0));
  let a = max(e.r, max(e.g, e.b));
  return vec4f(e, a);
}

// 元画像にグローを加算（HDR・プリマルチプライド）
@fragment
fn fs_add_glow(in: VOut) -> @location(0) vec4f {
  let base = textureSampleLevel(tex0, samp, in.uv, 0.0);
  let glow = textureSampleLevel(tex1, samp, in.uv, 0.0);
  let rgb = base.rgb + glow.rgb * u.intensity;
  let a = min(1.0, base.a + glow.a * u.intensity);
  return vec4f(rgb, a);
}

// シャープ（アンシャープマスク）: original + (original - blurred) * intensity
@fragment
fn fs_sharpen(in: VOut) -> @location(0) vec4f {
  let orig = textureSampleLevel(tex0, samp, in.uv, 0.0);
  let blur = textureSampleLevel(tex1, samp, in.uv, 0.0);
  let r = orig + (orig - blur) * u.intensity;
  return vec4f(max(r.rgb, vec3f(0.0)), clamp(r.a, 0.0, 1.0));
}

// 露出（明るさ）調整: rgb を 2^ev 倍（リニアに焼き込む。α は不変）
@fragment
fn fs_exposure(in: VOut) -> @location(0) vec4f {
  let c = textureSampleLevel(tex0, samp, in.uv, 0.0);
  return vec4f(c.rgb * exp2(u.ev), c.a);
}

// レベル補正（sRGB 域で per-channel。プリマルチ → straight に戻して適用）
fn f_srgb_to_linear(v: f32) -> f32 {
  if (v <= 0.04045) { return v / 12.92; }
  return pow((v + 0.055) / 1.055, 2.4);
}
fn f_linear_to_srgb(v: f32) -> f32 {
  let c = clamp(v, 0.0, 1.0);
  if (c <= 0.0031308) { return c * 12.92; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
fn levels1(v: f32) -> f32 {
  var n = (v - u.in_low) / max(u.in_high - u.in_low, 1e-4);
  n = clamp(n, 0.0, 1.0);
  n = pow(n, 1.0 / max(u.gamma, 1e-4));
  return u.out_low + n * (u.out_high - u.out_low);
}
@fragment
fn fs_levels(in: VOut) -> @location(0) vec4f {
  let c = textureSampleLevel(tex0, samp, in.uv, 0.0);
  let a = c.a;
  let straight = select(c.rgb, c.rgb / a, a > 0.0001);
  let s = vec3f(f_linear_to_srgb(straight.r), f_linear_to_srgb(straight.g), f_linear_to_srgb(straight.b));
  let adj = vec3f(levels1(s.r), levels1(s.g), levels1(s.b));
  let outLin = vec3f(f_srgb_to_linear(adj.r), f_srgb_to_linear(adj.g), f_srgb_to_linear(adj.b));
  return vec4f(outLin * a, a);
}

// トーンカーブ: sRGB 域の各chを LUT(tex1, 256x1) で写像
@fragment
fn fs_curve(in: VOut) -> @location(0) vec4f {
  let c = textureSampleLevel(tex0, samp, in.uv, 0.0);
  let a = c.a;
  let straight = select(c.rgb, c.rgb / a, a > 0.0001);
  let s = vec3f(f_linear_to_srgb(straight.r), f_linear_to_srgb(straight.g), f_linear_to_srgb(straight.b));
  let mr = textureSampleLevel(tex1, samp, vec2f(s.r, 0.5), 0.0).r;
  let mg = textureSampleLevel(tex1, samp, vec2f(s.g, 0.5), 0.0).r;
  let mb = textureSampleLevel(tex1, samp, vec2f(s.b, 0.5), 0.0).r;
  let outLin = vec3f(f_srgb_to_linear(mr), f_srgb_to_linear(mg), f_srgb_to_linear(mb));
  return vec4f(outLin * a, a);
}

// filtered と original を選択マスクで合成（マスク外は original のまま）
@fragment
fn fs_mask_composite(in: VOut) -> @location(0) vec4f {
  let filtered = textureSampleLevel(tex0, samp, in.uv, 0.0);
  let original = textureSampleLevel(tex1, samp, in.uv, 0.0);
  var m = 1.0;
  if (u.use_mask > 0.5) {
    m = textureSampleLevel(tex2, samp, in.uv, 0.0).r;
  }
  return mix(original, filtered, m);
}
