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
  intensity: f32,   // グロー強度
  use_mask: f32,    // 1=選択マスク適用
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
