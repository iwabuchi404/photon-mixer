/**
 * テクスチャ合成シェーダー
 * Phase 2: リニア -> sRGB 表示変換対応
 */

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var pos = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0,  1.0)
  );
  var uv = array<vec2f, 4>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 0.0)
  );
  var out: VertexOutput;
  out.position = vec4f(pos[vid], 0.0, 1.0);
  out.uv = uv[vid];
  return out;
}

@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

// --- 表示変換 (リニア -> sRGB 近似) ---
fn linear_to_srgb(v: f32) -> f32 {
  let c = clamp(v, 0.0, 1.0);
  if (c <= 0.0031308) { return c * 12.92; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

// そのまま出力 (ベイク用)
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  return textureSample(tex, samp, in.uv);
}

// sRGB 変換して出力 (画面表示用)
// テクスチャはプリマルチプライドα（r=R*α）で保存されているため
// アンプリマルチプライド → sRGB 変換 → 再プリマルチプライドの順で処理する
@fragment
fn fs_display(in: VertexOutput) -> @location(0) vec4f {
  let linear = textureSample(tex, samp, in.uv);
  let a = linear.a;
  if (a < 0.0001) { return vec4f(0.0); }
  let rgb = linear.rgb / a;
  let srgb = vec3f(linear_to_srgb(rgb.r), linear_to_srgb(rgb.g), linear_to_srgb(rgb.b));
  return vec4f(srgb * a, a);
}
