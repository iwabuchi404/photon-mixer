/**
 * テクスチャ合成シェーダー
 * Phase 3: ビューポート変換（ズーム・パン・回転）＋キャンバス背景・枠対応
 */

struct ViewportUniforms {
  scale: f32,
  offsetX: f32,
  offsetY: f32,
  rotation: f32,  // 回転角（ラジアン）
  canvas_width: f32,
  canvas_height: f32,
  screen_width: f32,
  screen_height: f32,
  flip: f32,        // 左右反転（1=通常, -1=反転）
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> viewport: ViewportUniforms;

// 通常のベイク用頂点シェーダー（テクスチャ全体をカバー）
@vertex
fn vs_bake(@builtin(vertex_index) vid: u32) -> VertexOutput {
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

// 画面表示用頂点シェーダー（ズーム・パン・回転を適用）
@vertex
fn vs_display(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var canvas_pos = array<vec2f, 4>(
    vec2f(0.0, viewport.canvas_height),
    vec2f(viewport.canvas_width, viewport.canvas_height),
    vec2f(0.0, 0.0),
    vec2f(viewport.canvas_width, 0.0)
  );

  var uv = array<vec2f, 4>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 0.0)
  );

  // 変換順序: キャンバス中心 → 左右反転 → スケール → 回転 → パン
  var c_pos = canvas_pos[vid] - vec2f(viewport.canvas_width, viewport.canvas_height) * 0.5;
  c_pos.x = c_pos.x * viewport.flip; // 中心軸で左右反転

  // スケールを適用
  let scaled = c_pos * viewport.scale;

  // 回転を適用
  let cos_r = cos(viewport.rotation);
  let sin_r = sin(viewport.rotation);
  let rotated = vec2f(
    scaled.x * cos_r - scaled.y * sin_r,
    scaled.x * sin_r + scaled.y * cos_r
  );

  // パンを適用（スクリーン座標系）
  let screen_pos = rotated + vec2f(viewport.offsetX, viewport.offsetY);

  // 画面中心を原点に
  let nx = (screen_pos.x / viewport.screen_width) * 2.0 - 1.0;
  let ny = 1.0 - (screen_pos.y / viewport.screen_height) * 2.0;

  var out: VertexOutput;
  out.position = vec4f(nx, ny, 0.0, 1.0);
  out.uv = uv[vid];
  return out;
}

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
@fragment
fn fs_display(in: VertexOutput) -> @location(0) vec4f {
  let linear = textureSample(tex, samp, in.uv);
  let a = linear.a;
  if (a < 0.0001) { return vec4f(0.0); }
  let rgb = linear.rgb / a;
  let srgb = vec3f(linear_to_srgb(rgb.r), linear_to_srgb(rgb.g), linear_to_srgb(rgb.b));
  return vec4f(srgb * a, a);
}

// キャンバスの背景（紙）と枠を描画
@fragment
fn fs_paper(in: VertexOutput) -> @location(0) vec4f {
  // 枠線の太さ (1px 相当を UV 空間に変換)
  let border_x = 1.5 / viewport.canvas_width;
  let border_y = 1.5 / viewport.canvas_height;
  
  // 枠線判定
  if (in.uv.x < border_x || in.uv.x > 1.0 - border_x || in.uv.y < border_y || in.uv.y > 1.0 - border_y) {
    return vec4f(0.3, 0.3, 0.3, 1.0); // 枠線の色 (ダークグレー)
  }
  
  return vec4f(0.18, 0.18, 0.18, 1.0); // キャンバスの色 (背景より少し明るい)
}
